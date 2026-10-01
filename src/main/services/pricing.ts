import { AppError } from '../../shared/errors';
import { lineAmount, toBaseQty } from '../../shared/qty';
import { percentOf } from '../../shared/money';
import { cartInput, type CartInput, type DiscountInput, type PromotionInput, promotionInput } from '../../shared/schemas';
import { type Ctx, audit, can, getSetting, requirePerm, today, ts } from './context';

export interface PricedLine {
  key?: string;
  productId: number;
  unitId: number;
  productName: string;
  unitName: string;
  qty: number; // milli of unit
  factor: number;
  baseQty: number;
  listPrice: number; // per unit
  unitPrice: number; // per unit (after manual override)
  priceOverridden: boolean;
  gross: number;
  promoDiscount: number;
  promotionId: number | null;
  promotionName: string | null;
  discount: number; // manual line discount
  invoiceDiscountShare: number;
  taxRate: number;
  tax: number;
  total: number; // charged incl. tax
  netRevenue: number; // excl. tax
  allowDecimal: boolean;
  isWeighted: boolean;
  stock: number;
  avgCost: number;
  discountInput: DiscountInput | null;
}

export interface PricedCart {
  lines: PricedLine[];
  subtotal: number;
  promoDiscount: number;
  lineDiscount: number; // manual line discounts
  invoiceDiscount: number;
  manualDiscountTotal: number;
  discountPct: number; // manual discounts as % of (subtotal - promo)
  taxTotal: number;
  rounding: number;
  total: number;
  netRevenue: number;
  itemsCount: number;
  needsApproval: { priceOverride: boolean; largeDiscount: boolean; discount: boolean };
  customerId: number | null;
  priceListId: number | null;
  promoHints: string[];
}

export interface PromoRow {
  id: number; name: string; type: 'percent' | 'amount' | 'bundle' | 'bxgy' | 'cross' | 'combo'; product_id: number | null; category_id: number | null;
  min_qty: number; get_qty: number; value: number; reward_product_id: number | null; reward_qty: number; reward_type: 'free' | 'percent' | null; max_per_invoice: number | null;
}

function activePromotions(ctx: Ctx): PromoRow[] {
  if (!getSetting(ctx.db, 'features.promotions')) return [];
  const d = today(ctx);
  return ctx.db.prepare(
    `SELECT id, name, type, product_id, category_id, min_qty, get_qty, value, reward_product_id, reward_qty, reward_type, max_per_invoice FROM promotions
     WHERE active = 1 AND (start_date IS NULL OR start_date <= @d) AND (end_date IS NULL OR end_date >= @d)`,
  ).all({ d }) as PromoRow[];
}

/**
 * Promotion discount for a line. Quantities are base milli; pricePerBase is
 * the effective unit price converted to the base unit.
 */
export function promoDiscountFor(promo: PromoRow, baseQty: number, gross: number): number {
  switch (promo.type) {
    case 'percent': // value = percent x 100
      return baseQty >= promo.min_qty ? percentOf(gross, promo.value / 100) : 0;
    case 'amount': // value = amount off per base unit (minor)
      return baseQty >= promo.min_qty ? Math.min(gross, lineAmount(promo.value, baseQty)) : 0;
    case 'bundle': { // min_qty units for `value` total
      if (promo.min_qty <= 0) return 0;
      const bundles = Math.floor(baseQty / promo.min_qty);
      if (bundles <= 0) return 0;
      const regularBundle = Math.round((gross * promo.min_qty) / baseQty);
      return Math.max(0, bundles * (regularBundle - promo.value));
    }
    case 'bxgy': { // buy min_qty get get_qty free
      const group = promo.min_qty + promo.get_qty;
      if (promo.get_qty <= 0 || group <= 0) return 0;
      const freeUnits = Math.floor(baseQty / group) * promo.get_qty;
      return Math.round((gross * freeUnits) / baseQty);
    }
  }
  return 0;
}

function applyDiscount(base: number, d: DiscountInput | null | undefined): number {
  if (!d || d.value <= 0) return 0;
  const v = d.type === 'percent' ? percentOf(base, Math.min(d.value, 100)) : Math.round(d.value);
  return Math.min(Math.max(v, 0), Math.max(base, 0));
}

/** Allocate an amount across weights with the largest-remainder method (exact sum). */
export function allocate(amount: number, weights: number[]): number[] {
  const totalW = weights.reduce((a, b) => a + b, 0);
  if (amount === 0 || totalW <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / totalW);
  const floors = raw.map((r) => Math.floor(r));
  let rest = amount - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const o of order) {
    if (rest <= 0) break;
    floors[o.i]++;
    rest--;
  }
  return floors;
}

interface ProductPriceRow {
  id: number; name: string; variant_name: string | null; sell_price: number; avg_cost: number; tax_rate: number | null; category_id: number | null;
  active: number; allow_discount: number; is_weighted: number; stock: number;
}

/** Authoritative pricing of a cart. Used for live preview and at checkout. */
export function priceCart(ctx: Ctx, raw: CartInput): PricedCart {
  const cart = cartInput.parse(raw);
  const db = ctx.db;
  let priceListId = cart.priceListId ?? null;
  if (cart.customerId) {
    const c = db.prepare('SELECT price_list_id FROM customers WHERE id = ?').get(cart.customerId) as { price_list_id: number | null } | undefined;
    if (!c) throw new AppError('NOT_FOUND');
    if (!priceListId) priceListId = c.price_list_id;
  }
  if (!getSetting(db, 'features.priceLists')) priceListId = null;
  const promos = activePromotions(ctx);
  const taxOn = getSetting(db, 'features.tax');
  const storeRate = getSetting(db, 'tax.rate');
  const inclusive = getSetting(db, 'tax.inclusive');

  const pStmt = db.prepare(
    `SELECT p.id, p.name, p.variant_name, p.sell_price, p.avg_cost, p.tax_rate, p.category_id, p.active, p.allow_discount, p.is_weighted,
            (SELECT COALESCE(SUM(qty),0) FROM product_stock s WHERE s.product_id = p.id) AS stock FROM products p WHERE p.id = ?`,
  );
  const uStmt = db.prepare(
    `SELECT pu.factor, pu.sell_price, u.name, u.symbol, u.allow_decimal FROM product_units pu JOIN units u ON u.id = pu.unit_id WHERE pu.product_id = ? AND pu.unit_id = ?`,
  );
  const plStmt = db.prepare('SELECT price FROM product_prices WHERE product_id = ? AND price_list_id = ?');

  const needs = { priceOverride: false, largeDiscount: false, discount: false };
  const lines: PricedLine[] = [];
  const taxRates: number[] = [];
  for (const l of cart.lines) {
    const p = pStmt.get(l.productId) as ProductPriceRow | undefined;
    if (!p) throw new AppError('NOT_FOUND');
    if (!p.active) throw new AppError('PRODUCT_INACTIVE', { name: p.name });
    const u = uStmt.get(l.productId, l.unitId) as { factor: number; sell_price: number | null; name: string; symbol: string; allow_decimal: number } | undefined;
    if (!u) throw new AppError('INVALID_UNIT');
    if (!u.allow_decimal && l.qty % 1000 !== 0) throw new AppError('DECIMAL_NOT_ALLOWED', { name: p.name });
    const baseQty = toBaseQty(l.qty, u.factor);
    if (baseQty <= 0) throw new AppError('INVALID_QTY');
    // list price per unit: price list (per base) > unit-specific price > base price x factor
    let plPrice: number | null = null;
    if (priceListId) {
      const pl = plStmt.get(l.productId, priceListId) as { price: number } | undefined;
      if (pl) plPrice = pl.price;
    }
    const listPrice = plPrice !== null
      ? Math.round((plPrice * u.factor) / 1000)
      : u.sell_price ?? Math.round((p.sell_price * u.factor) / 1000);
    let unitPrice = listPrice;
    let overridden = false;
    if (l.unitPrice !== null && l.unitPrice !== undefined && l.unitPrice !== listPrice) {
      unitPrice = l.unitPrice;
      overridden = true;
      needs.priceOverride = true;
    }
    const gross = lineAmount(unitPrice, l.qty);
    // best promotion
    let promoDiscount = 0;
    let promo: PromoRow | null = null;
    if (!overridden) {
      for (const pr of promos) {
        if (pr.type === 'cross' || pr.type === 'combo') continue; // cart-level, applied below
        if (pr.product_id && pr.product_id !== p.id) continue;
        if (!pr.product_id && pr.category_id && pr.category_id !== p.category_id) continue;
        if (!pr.product_id && !pr.category_id) continue;
        const d = Math.min(promoDiscountFor(pr, baseQty, gross), gross);
        if (d > promoDiscount) { promoDiscount = d; promo = pr; }
      }
    }
    let discount = 0;
    if (l.discount && l.discount.value > 0) {
      if (!p.allow_discount) throw new AppError('VALIDATION', { detail: `المنتج "${p.name}" لا يقبل خصمًا` });
      discount = applyDiscount(gross - promoDiscount, l.discount);
      if (discount > 0) needs.discount = true;
    }
    const name = p.variant_name ? `${p.name} ${p.variant_name}`.trim() : p.name;
    lines.push({
      key: l.key, productId: p.id, unitId: l.unitId, productName: name, unitName: u.name, qty: l.qty, factor: u.factor, baseQty,
      listPrice, unitPrice, priceOverridden: overridden, gross, promoDiscount, promotionId: promo?.id ?? null, promotionName: promo?.name ?? null,
      discount, invoiceDiscountShare: 0, taxRate: 0, tax: 0, total: 0, netRevenue: 0, allowDecimal: !!u.allow_decimal, isWeighted: !!p.is_weighted,
      stock: p.stock, avgCost: p.avg_cost, discountInput: l.discount ?? null,
    });
    taxRates.push(taxOn ? (p.tax_rate ?? storeRate) : 0);
  }

  const hints = applyCrossPromotions(promos, lines);

  const subtotal = lines.reduce((a, l) => a + l.gross, 0);
  const promoTotal = lines.reduce((a, l) => a + l.promoDiscount, 0);
  const lineDiscount = lines.reduce((a, l) => a + l.discount, 0);
  const afterLine = subtotal - promoTotal - lineDiscount;
  const invoiceDiscount = applyDiscount(afterLine, cart.invoiceDiscount);
  if (invoiceDiscount > 0) needs.discount = true;
  const shares = allocate(invoiceDiscount, lines.map((l) => l.gross - l.promoDiscount - l.discount));
  let taxTotal = 0;
  let total = 0;
  let netRevenue = 0;
  lines.forEach((l, i) => {
    l.invoiceDiscountShare = shares[i];
    const net = l.gross - l.promoDiscount - l.discount - l.invoiceDiscountShare;
    const rate = taxRates[i];
    l.taxRate = rate;
    if (rate > 0) {
      if (inclusive) { l.tax = Math.round((net * rate) / (100 + rate)); l.total = net; }
      else { l.tax = Math.round((net * rate) / 100); l.total = net + l.tax; }
    } else { l.tax = 0; l.total = net; }
    l.netRevenue = l.total - l.tax;
    taxTotal += l.tax;
    total += l.total;
    netRevenue += l.netRevenue;
  });
  // cash rounding (e.g. to nearest 0.25 / 0.50 / 1.00)
  const roundTo = getSetting(db, 'sales.roundTo');
  let rounding = 0;
  if (roundTo > 0 && total > 0) {
    const rounded = Math.round(total / roundTo) * roundTo;
    rounding = rounded - total;
    total = rounded;
    netRevenue += rounding;
  }
  const manualDiscountTotal = lineDiscount + invoiceDiscount;
  const base = subtotal - promoTotal;
  const discountPct = base > 0 ? (manualDiscountTotal * 100) / base : 0;
  const userMax = ctx.user?.maxDiscountPct ?? getSetting(db, 'sales.maxDiscountPct');
  if (manualDiscountTotal > 0 && discountPct > userMax + 1e-9) needs.largeDiscount = true;
  return {
    lines, subtotal, promoDiscount: promoTotal, lineDiscount, invoiceDiscount, manualDiscountTotal, discountPct: Math.round(discountPct * 100) / 100,
    taxTotal, rounding, total, netRevenue, itemsCount: lines.length, needsApproval: needs, customerId: cart.customerId ?? null, priceListId, promoHints: hints,
  };
}

/**
 * Cross-product promotions, evaluated on the whole cart:
 *  - cross: buy `min_qty` of A -> `reward_qty` of B free (or % off), capped by max_per_invoice
 *  - combo: `min_qty` of A + `reward_qty` of B for a fixed `value`
 * A line keeps whichever promotion gives the customer more; discounts are
 * allocated onto the involved lines so revenue, stock and cost stay exact.
 * Returns hints for the cashier when a promotion is one item away.
 */
export function applyCrossPromotions(promos: PromoRow[], lines: PricedLine[]): string[] {
  const hints: string[] = [];
  const cross = promos.filter((p) => (p.type === 'cross' || p.type === 'combo') && p.product_id && p.reward_product_id && p.min_qty > 0 && p.reward_qty > 0);
  if (!cross.length) return hints;
  const byProduct = (pid: number) => lines.filter((l) => l.productId === pid && !l.priceOverridden);
  const evaluated = cross.map((pr) => {
    const aLines = byProduct(pr.product_id!);
    const bLines = byProduct(pr.reward_product_id!);
    const aQty = aLines.reduce((x, l) => x + l.baseQty, 0);
    const bQty = bLines.reduce((x, l) => x + l.baseQty, 0);
    let times = Math.min(Math.floor(aQty / pr.min_qty), Math.floor(bQty / pr.reward_qty));
    if (pr.max_per_invoice) times = Math.min(times, pr.max_per_invoice);
    // effective charged price per milli of base unit (gross / base milli)
    const perMilli = (ls: PricedLine[], q: number) => (q > 0 ? ls.reduce((x, l) => x + l.gross, 0) / q : 0);
    let discount = 0;
    if (times > 0) {
      const rewardValue = Math.round(perMilli(bLines, bQty) * pr.reward_qty * times);
      if (pr.type === 'cross') discount = pr.reward_type === 'percent' ? Math.round((rewardValue * pr.value) / 10000) : rewardValue;
      else {
        const aValue = Math.round(perMilli(aLines, aQty) * pr.min_qty * times);
        discount = Math.max(0, aValue + rewardValue - pr.value * times);
      }
    }
    if (aQty >= pr.min_qty && bQty < pr.reward_qty && times === 0) hints.push(pr.name);
    return { pr, aLines, bLines, discount, times };
  }).filter((e) => e.discount > 0).sort((a, b) => b.discount - a.discount);
  const claimed = new Set<PricedLine>();
  for (const e of evaluated) {
    const involved = e.pr.type === 'cross' ? e.bLines : [...e.aLines, ...e.bLines];
    if (involved.some((l) => claimed.has(l))) continue;
    const existing = involved.reduce((x, l) => x + l.promoDiscount, 0);
    if (e.discount <= existing) continue; // the single-product promotion is better for the customer
    const shares = allocate(e.discount, involved.map((l) => l.gross));
    involved.forEach((l, i) => {
      l.promoDiscount = Math.min(l.gross, shares[i]);
      l.promotionId = e.pr.id;
      l.promotionName = e.pr.name;
      // a manual discount can never push the line below zero
      l.discount = Math.min(l.discount, l.gross - l.promoDiscount);
      claimed.add(l);
    });
  }
  return hints;
}

/** Which approvals are still missing for the current user (and approver). */
export function missingApprovals(ctx: Ctx, priced: PricedCart): string[] {
  const missing: string[] = [];
  const has = (p: Parameters<typeof can>[1]) => can(ctx, p) || (!!ctx.approver && (ctx.approver.permissions === '*' || ctx.approver.permissions.includes(p)));
  if (priced.needsApproval.priceOverride && !has('pos.price_override')) missing.push('pos.price_override');
  if (priced.needsApproval.discount && !has('pos.discount')) missing.push('pos.discount');
  if (priced.needsApproval.largeDiscount && !has('pos.discount_large')) missing.push('pos.discount_large');
  return missing;
}

/* ------------------------------------------------------------------ promotions CRUD */

export function listPromotions(ctx: Ctx) {
  return ctx.db.prepare(
    `SELECT pr.*, p.name AS product_name, c.name AS category_name, rp.name AS reward_product_name FROM promotions pr
     LEFT JOIN products p ON p.id = pr.product_id LEFT JOIN categories c ON c.id = pr.category_id LEFT JOIN products rp ON rp.id = pr.reward_product_id
     ORDER BY pr.active DESC, pr.id DESC`,
  ).all();
}

export function savePromotion(ctx: Ctx, id: number | null, raw: PromotionInput) {
  requirePerm(ctx, 'products.edit_price');
  const p = promotionInput.parse(raw);
  if (!p.productId && !p.categoryId) throw new AppError('VALIDATION', { detail: 'اختر منتجًا أو تصنيفًا للعرض' });
  if ((p.type === 'cross' || p.type === 'combo') && (!p.productId || !p.rewardProductId || !p.rewardQty)) throw new AppError('VALIDATION', { detail: 'العرض المرتبط يحتاج المنتج الأساسي والمنتج الثاني والكمية' });
  if (p.type === 'percent' && p.value > 10000) throw new AppError('VALIDATION', { detail: 'نسبة الخصم لا تتجاوز 100%' });
  if (p.type === 'bxgy' && p.getQty <= 0) throw new AppError('VALIDATION', { detail: 'حدد كمية الهدية' });
  if (p.startDate && p.endDate && p.endDate < p.startDate) throw new AppError('VALIDATION', { detail: 'تاريخ النهاية قبل تاريخ البداية' });
  const params = {
    name: p.name, type: p.type, pid: p.productId ?? null, cid: p.productId ? null : p.categoryId ?? null, min: p.minQty, get: p.getQty,
    value: p.value, sd: p.startDate ?? null, ed: p.endDate ?? null, active: p.active ? 1 : 0, now: ts(ctx),
    rp: p.rewardProductId ?? null, rq: p.rewardQty ?? 0, rt: p.type === 'cross' ? p.rewardType ?? 'free' : null, mpi: p.maxPerInvoice ?? null, uid: ctx.user?.id ?? null,
  };
  if (id) {
    ctx.db.prepare(`UPDATE promotions SET name=@name, type=@type, product_id=@pid, category_id=@cid, min_qty=@min, get_qty=@get, value=@value, start_date=@sd, end_date=@ed, active=@active,
      reward_product_id=@rp, reward_qty=@rq, reward_type=@rt, max_per_invoice=@mpi WHERE id=@id`).run({ ...params, id });
    audit(ctx, 'promotion.update', 'promotion', id, undefined, p);
    return { id };
  }
  const info = ctx.db.prepare(`INSERT INTO promotions(name, type, product_id, category_id, min_qty, get_qty, value, start_date, end_date, active, created_at,
    reward_product_id, reward_qty, reward_type, max_per_invoice, created_by) VALUES (@name, @type, @pid, @cid, @min, @get, @value, @sd, @ed, @active, @now, @rp, @rq, @rt, @mpi, @uid)`).run(params);
  audit(ctx, 'promotion.create', 'promotion', Number(info.lastInsertRowid), undefined, p);
  return { id: Number(info.lastInsertRowid) };
}

export function deletePromotion(ctx: Ctx, id: number) {
  requirePerm(ctx, 'products.edit_price');
  ctx.db.prepare('DELETE FROM promotions WHERE id = ?').run(id);
  audit(ctx, 'promotion.delete', 'promotion', id);
  return { ok: true };
}
