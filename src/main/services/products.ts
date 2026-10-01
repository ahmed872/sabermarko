import { AppError } from '../../shared/errors';
import { normalizeArabic } from '../../shared/arabic';
import { productInput, type ProductInput } from '../../shared/schemas';
import { type Ctx, audit, can, defaultLocationId, getSetting, requirePerm, ts, tx } from './context';
import { receiveStock } from './inventory';

export interface UnitRow { id: number; name: string; symbol: string; kind: string; allow_decimal: number; is_system: number; active: number }

export interface ProductUnitRow {
  id: number | null; product_id: number; unit_id: number; factor: number; barcode: string | null; sell_price: number | null;
  is_default_sale: number; is_default_purchase: number; unit_name: string; unit_symbol: string; allow_decimal: number;
}

export interface PosProduct {
  id: number; name: string; short_name: string | null; variant_name: string | null; group_id: number | null; group_name: string | null;
  sell_price: number; is_weighted: number; allow_discount: number; base_unit_id: number; stock: number; category_id: number | null;
  barcode: string | null; sku: string | null; image: string | null; is_favorite: number; avg_cost?: number;
  units: ProductUnitRow[];
  /** set when matched by a unit barcode or scale barcode */
  matchedUnitId?: number;
  matchedQty?: number;
  matchedPrice?: number;
}

function cleanCode(s: string | null | undefined): string | null {
  const v = (s ?? '').trim();
  return v === '' ? null : v;
}

export function buildSearchText(db: Ctx['db'], productId: number): void {
  const p = db.prepare(
    `SELECT p.name, p.short_name, p.variant_name, p.sku, p.barcode, b.name AS brand, c.name AS category, g.name AS grp
     FROM products p LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_groups g ON g.id = p.group_id WHERE p.id = ?`,
  ).get(productId) as Record<string, string | null>;
  const unitCodes = (db.prepare('SELECT barcode FROM product_units WHERE product_id = ? AND barcode IS NOT NULL').all(productId) as { barcode: string }[]).map((r) => r.barcode);
  const text = normalizeArabic([p.name, p.short_name, p.variant_name, p.grp, p.brand, p.category, p.sku, p.barcode, ...unitCodes].filter(Boolean).join(' '));
  db.prepare('UPDATE products SET search_text = ? WHERE id = ?').run(` ${text} `, productId);
}

function assertCodesFree(ctx: Ctx, productId: number | null, barcodes: (string | null)[], sku: string | null) {
  const db = ctx.db;
  const seen = new Set<string>();
  for (const code of barcodes) {
    if (!code) continue;
    if (seen.has(code)) throw new AppError('DUPLICATE_BARCODE', { barcode: code });
    seen.add(code);
    const a = db.prepare('SELECT id FROM products WHERE barcode = ? AND id IS NOT ?').get(code, productId) as { id: number } | undefined;
    const b = db.prepare('SELECT product_id AS id FROM product_units WHERE barcode = ? AND product_id IS NOT ?').get(code, productId) as { id: number } | undefined;
    if (a || b) throw new AppError('DUPLICATE_BARCODE', { barcode: code });
  }
  if (sku) {
    const s = db.prepare('SELECT id FROM products WHERE sku = ? AND id IS NOT ?').get(sku, productId);
    if (s) throw new AppError('DUPLICATE_SKU', { sku });
  }
}

function resolveGroup(ctx: Ctx, name: string | null | undefined): number | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  const row = ctx.db.prepare('SELECT id FROM product_groups WHERE name = ?').get(n) as { id: number } | undefined;
  if (row) return row.id;
  return Number(ctx.db.prepare('INSERT INTO product_groups(name, created_at) VALUES (?, ?)').run(n, ts(ctx)).lastInsertRowid);
}

function resolveBrand(ctx: Ctx, brandId: number | null | undefined, brandName: string | null | undefined): number | null {
  if (brandId) return brandId;
  const n = (brandName ?? '').trim();
  if (!n) return null;
  const row = ctx.db.prepare('SELECT id FROM brands WHERE name = ?').get(n) as { id: number } | undefined;
  if (row) return row.id;
  return Number(ctx.db.prepare('INSERT INTO brands(name) VALUES (?)').run(n).lastInsertRowid);
}

function writeUnits(ctx: Ctx, productId: number, baseUnitId: number, units: ProductInput['units']) {
  const db = ctx.db;
  const list = (units ?? []).filter((u) => u.unitId !== baseUnitId);
  const keepIds = list.map((u) => u.unitId);
  // remove units no longer present (only if never used in history)
  const existing = db.prepare('SELECT unit_id FROM product_units WHERE product_id = ?').all(productId) as { unit_id: number }[];
  for (const e of existing) {
    if (e.unit_id === baseUnitId || keepIds.includes(e.unit_id)) continue;
    db.prepare('DELETE FROM product_units WHERE product_id = ? AND unit_id = ?').run(productId, e.unit_id);
  }
  const hasSaleDefault = list.some((u) => u.isDefaultSale);
  const hasPurchaseDefault = list.some((u) => u.isDefaultPurchase);
  const up = db.prepare(
    `INSERT INTO product_units(product_id, unit_id, factor, barcode, sell_price, is_default_sale, is_default_purchase)
     VALUES (@pid, @uid, @factor, @barcode, @price, @ds, @dp)
     ON CONFLICT(product_id, unit_id) DO UPDATE SET factor = excluded.factor, barcode = excluded.barcode, sell_price = excluded.sell_price,
       is_default_sale = excluded.is_default_sale, is_default_purchase = excluded.is_default_purchase`,
  );
  // base unit row always exists with factor 1000
  up.run({ pid: productId, uid: baseUnitId, factor: 1000, barcode: null, price: null, ds: hasSaleDefault ? 0 : 1, dp: hasPurchaseDefault ? 0 : 1 });
  for (const u of list) {
    up.run({ pid: productId, uid: u.unitId, factor: u.factor, barcode: cleanCode(u.barcode), price: u.sellPrice ?? null, ds: u.isDefaultSale ? 1 : 0, dp: u.isDefaultPurchase ? 1 : 0 });
  }
}

function writePrices(ctx: Ctx, productId: number, prices: ProductInput['prices']) {
  ctx.db.prepare('DELETE FROM product_prices WHERE product_id = ?').run(productId);
  const ins = ctx.db.prepare('INSERT INTO product_prices(product_id, price_list_id, price) VALUES (?, ?, ?)');
  for (const p of prices ?? []) {
    const def = ctx.db.prepare('SELECT is_default FROM price_lists WHERE id = ?').get(p.priceListId) as { is_default: number } | undefined;
    if (!def || def.is_default) continue; // retail price lives on products.sell_price
    ins.run(productId, p.priceListId, p.price);
  }
}

function logPrice(ctx: Ctx, productId: number, kind: 'sell' | 'cost', oldPrice: number | null, newPrice: number, extra: { supplierId?: number | null; refType?: string; refId?: number } = {}) {
  ctx.db.prepare(
    `INSERT INTO price_history(product_id, kind, old_price, new_price, supplier_id, ref_type, ref_id, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(productId, kind, oldPrice, newPrice, extra.supplierId ?? null, extra.refType ?? null, extra.refId ?? null, ctx.user?.id ?? null, ts(ctx));
}
export { logPrice };

export function createProduct(ctx: Ctx, raw: ProductInput) {
  requirePerm(ctx, 'products.manage');
  const input = productInput.parse(raw);
  const barcode = cleanCode(input.barcode);
  const sku = cleanCode(input.sku);
  if (input.cost !== undefined && input.cost > 0 && !can(ctx, 'products.edit_cost')) requirePerm(ctx, 'products.edit_cost');
  return tx(ctx, () => {
    assertCodesFree(ctx, null, [barcode, ...input.units.map((u) => cleanCode(u.barcode))], sku);
    const unit = ctx.db.prepare('SELECT * FROM units WHERE id = ?').get(input.baseUnitId) as UnitRow | undefined;
    if (!unit) throw new AppError('INVALID_UNIT');
    const now = ts(ctx);
    const cost = input.cost ?? 0;
    const info = ctx.db.prepare(
      `INSERT INTO products(name, short_name, category_id, brand_id, group_id, variant_name, base_unit_id, sku, barcode, sell_price, avg_cost, last_cost,
        min_stock, reorder_qty, is_weighted, track_expiry, tax_rate, default_supplier_id, is_favorite, allow_discount, image, notes, active, created_at, updated_at)
       VALUES (@name, @short, @cat, @brand, @grp, @variant, @unit, @sku, @barcode, @price, @cost, @cost, @min, @reorder, @weighted, @expiry, @tax, @supplier, @fav, @disc, @image, @notes, @active, @now, @now)`,
    ).run({
      name: input.name, short: input.shortName ?? null, cat: input.categoryId ?? null, brand: resolveBrand(ctx, input.brandId, input.brandName),
      grp: resolveGroup(ctx, input.groupName), variant: input.variantName ?? null, unit: input.baseUnitId, sku, barcode, price: input.sellPrice,
      cost, min: input.minStock, reorder: input.reorderQty ?? null, weighted: input.isWeighted || unit.kind === 'weight' ? 1 : 0,
      expiry: input.trackExpiry ? 1 : 0, tax: input.taxRate ?? null, supplier: input.defaultSupplierId ?? null, fav: input.isFavorite ? 1 : 0,
      disc: input.allowDiscount ? 1 : 0, image: input.image ?? null, notes: input.notes ?? null, active: input.active ? 1 : 0, now,
    });
    const id = Number(info.lastInsertRowid);
    writeUnits(ctx, id, input.baseUnitId, input.units);
    writePrices(ctx, id, input.prices);
    buildSearchText(ctx.db, id);
    logPrice(ctx, id, 'sell', null, input.sellPrice);
    if (cost > 0) logPrice(ctx, id, 'cost', null, cost);
    if (input.openingStock && input.openingStock.qty > 0) {
      const o = input.openingStock;
      const docRef = ctx.db.prepare(
        `INSERT INTO inventory_docs(doc_no, type, from_location_id, reason, user_id, business_date, created_at) VALUES (?, 'opening', ?, ?, ?, ?, ?)`,
      ).run(`OPEN-${id}`, o.locationId ?? defaultLocationId(ctx.db), 'رصيد افتتاحي عند إضافة المنتج', ctx.user?.id ?? null, now.slice(0, 10), now);
      receiveStock(ctx, {
        productId: id, locationId: o.locationId ?? defaultLocationId(ctx.db), qty: o.qty, unitCost: o.unitCost ?? cost,
        type: 'opening', refType: 'inventory_doc', refId: Number(docRef.lastInsertRowid), note: 'رصيد افتتاحي',
        batch: { expiryDate: o.expiryDate, batchNo: o.batchNo },
      });
    }
    audit(ctx, 'product.create', 'product', id, undefined, { name: input.name, sellPrice: input.sellPrice, cost });
    return { id };
  });
}

export function updateProduct(ctx: Ctx, id: number, raw: ProductInput) {
  requirePerm(ctx, 'products.manage');
  const input = productInput.parse(raw);
  const barcode = cleanCode(input.barcode);
  const sku = cleanCode(input.sku);
  return tx(ctx, () => {
    const cur = ctx.db.prepare('SELECT * FROM products WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (!cur) throw new AppError('NOT_FOUND');
    assertCodesFree(ctx, id, [barcode, ...input.units.map((u) => cleanCode(u.barcode))], sku);
    const priceChanged = cur.sell_price !== input.sellPrice;
    if (priceChanged) requirePerm(ctx, 'products.edit_price');
    const costChanged = input.cost !== undefined && Math.abs(cur.avg_cost - input.cost) > 0.0001;
    if (costChanged) requirePerm(ctx, 'products.edit_cost');
    if (cur.base_unit_id !== input.baseUnitId) {
      const used = ctx.db.prepare('SELECT 1 FROM stock_movements WHERE product_id = ? LIMIT 1').get(id);
      if (used) throw new AppError('VALIDATION', { detail: 'لا يمكن تغيير الوحدة الأساسية لمنتج له حركات مخزون' });
    }
    const unit = ctx.db.prepare('SELECT * FROM units WHERE id = ?').get(input.baseUnitId) as UnitRow | undefined;
    if (!unit) throw new AppError('INVALID_UNIT');
    ctx.db.prepare(
      `UPDATE products SET name=@name, short_name=@short, category_id=@cat, brand_id=@brand, group_id=@grp, variant_name=@variant, base_unit_id=@unit,
        sku=@sku, barcode=@barcode, sell_price=@price, avg_cost=@cost, min_stock=@min, reorder_qty=@reorder, is_weighted=@weighted, track_expiry=@expiry,
        tax_rate=@tax, default_supplier_id=@supplier, is_favorite=@fav, allow_discount=@disc, image=@image, notes=@notes, active=@active, updated_at=@now
       WHERE id=@id`,
    ).run({
      id, name: input.name, short: input.shortName ?? null, cat: input.categoryId ?? null, brand: resolveBrand(ctx, input.brandId, input.brandName),
      grp: resolveGroup(ctx, input.groupName), variant: input.variantName ?? null, unit: input.baseUnitId, sku, barcode, price: input.sellPrice,
      cost: costChanged ? input.cost : cur.avg_cost, min: input.minStock, reorder: input.reorderQty ?? null,
      weighted: input.isWeighted || unit.kind === 'weight' ? 1 : 0, expiry: input.trackExpiry ? 1 : 0, tax: input.taxRate ?? null,
      supplier: input.defaultSupplierId ?? null, fav: input.isFavorite ? 1 : 0, disc: input.allowDiscount ? 1 : 0, image: input.image ?? null,
      notes: input.notes ?? null, active: input.active ? 1 : 0, now: ts(ctx),
    });
    writeUnits(ctx, id, input.baseUnitId, input.units);
    writePrices(ctx, id, input.prices);
    buildSearchText(ctx.db, id);
    if (priceChanged) {
      logPrice(ctx, id, 'sell', cur.sell_price, input.sellPrice);
      audit(ctx, 'product.price_change', 'product', id, { sellPrice: cur.sell_price }, { sellPrice: input.sellPrice });
    }
    if (costChanged) {
      logPrice(ctx, id, 'cost', cur.avg_cost, input.cost!);
      audit(ctx, 'product.cost_change', 'product', id, { avgCost: cur.avg_cost }, { avgCost: input.cost });
    }
    if (cur.active && !input.active) audit(ctx, 'product.deactivate', 'product', id, undefined, { name: cur.name });
    audit(ctx, 'product.update', 'product', id, { name: cur.name }, { name: input.name });
    return { id };
  });
}

export function setProductActive(ctx: Ctx, id: number, active: boolean) {
  requirePerm(ctx, 'products.delete');
  const r = ctx.db.prepare('UPDATE products SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, ts(ctx), id);
  if (!r.changes) throw new AppError('NOT_FOUND');
  audit(ctx, active ? 'product.activate' : 'product.deactivate', 'product', id);
  return { ok: true };
}

/** Hard delete only when the product has no history at all; otherwise archive. */
export function deleteProduct(ctx: Ctx, id: number) {
  requirePerm(ctx, 'products.delete');
  return tx(ctx, () => {
    const used = ctx.db.prepare(
      `SELECT 1 FROM stock_movements WHERE product_id = @id UNION ALL SELECT 1 FROM sale_items WHERE product_id = @id
       UNION ALL SELECT 1 FROM purchase_items WHERE product_id = @id UNION ALL SELECT 1 FROM purchase_order_items WHERE product_id = @id LIMIT 1`,
    ).get({ id });
    if (used) throw new AppError('PRODUCT_IN_USE');
    const p = ctx.db.prepare('SELECT name FROM products WHERE id = ?').get(id) as { name: string } | undefined;
    if (!p) throw new AppError('NOT_FOUND');
    ctx.db.prepare('DELETE FROM stocktake_items WHERE product_id = ?').run(id);
    ctx.db.prepare('DELETE FROM product_stock WHERE product_id = ?').run(id);
    ctx.db.prepare('DELETE FROM price_history WHERE product_id = ?').run(id);
    ctx.db.prepare('DELETE FROM promotions WHERE product_id = ?').run(id);
    ctx.db.prepare('DELETE FROM batches WHERE product_id = ?').run(id);
    ctx.db.prepare('DELETE FROM products WHERE id = ?').run(id);
    audit(ctx, 'product.delete', 'product', id, { name: p.name });
    return { ok: true };
  });
}

export function toggleFavorite(ctx: Ctx, id: number, fav: boolean) {
  requirePerm(ctx, 'products.manage');
  const max = ctx.db.prepare('SELECT COALESCE(MAX(favorite_order),0) AS m FROM products').get() as { m: number };
  ctx.db.prepare('UPDATE products SET is_favorite = ?, favorite_order = ? WHERE id = ?').run(fav ? 1 : 0, fav ? max.m + 1 : 0, id);
  return { ok: true };
}

export function getProduct(ctx: Ctx, id: number): any {
  requirePerm(ctx, 'products.view');
  const p = ctx.db.prepare(
    `SELECT p.*, c.name AS category_name, b.name AS brand_name, g.name AS group_name, u.name AS unit_name, u.symbol AS unit_symbol,
            u.allow_decimal, s.name AS supplier_name
     FROM products p JOIN units u ON u.id = p.base_unit_id LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN product_groups g ON g.id = p.group_id LEFT JOIN suppliers s ON s.id = p.default_supplier_id
     WHERE p.id = ?`,
  ).get(id) as Record<string, any> | undefined;
  if (!p) throw new AppError('NOT_FOUND');
  const units = productUnits(ctx, id);
  const prices = ctx.db.prepare('SELECT pp.price_list_id, pp.price, pl.name FROM product_prices pp JOIN price_lists pl ON pl.id = pp.price_list_id WHERE pp.product_id = ?').all(id);
  const stock = ctx.db.prepare('SELECT l.id AS location_id, l.name, COALESCE(s.qty,0) AS qty FROM locations l LEFT JOIN product_stock s ON s.location_id = l.id AND s.product_id = ? WHERE l.active = 1 ORDER BY l.is_default DESC, l.id').all(id);
  const totalQty = (stock as { qty: number }[]).reduce((a, r) => a + r.qty, 0);
  if (!can(ctx, 'reports.cost') && !can(ctx, 'products.edit_cost')) { p.avg_cost = null; p.last_cost = null; }
  const variants = p.group_id
    ? ctx.db.prepare('SELECT id, name, variant_name, sell_price, active FROM products WHERE group_id = ? AND id <> ? ORDER BY name').all(p.group_id, id)
    : [];
  return { ...p, units, prices, stock, totalQty, variants };
}

export function productUnits(ctx: Ctx, productId: number): ProductUnitRow[] {
  return ctx.db.prepare(
    `SELECT pu.id, pu.product_id, pu.unit_id, pu.factor, pu.barcode, pu.sell_price, pu.is_default_sale, pu.is_default_purchase,
            u.name AS unit_name, u.symbol AS unit_symbol, u.allow_decimal
     FROM product_units pu JOIN units u ON u.id = pu.unit_id WHERE pu.product_id = ? ORDER BY pu.factor`,
  ).all(productId) as ProductUnitRow[];
}

export interface ProductListQuery {
  q?: string; categoryId?: number | null; brandId?: number | null; status?: 'active' | 'inactive' | 'all';
  stock?: 'low' | 'out' | 'negative' | null; page?: number; pageSize?: number; sort?: 'name' | 'stock' | 'price' | 'recent'; supplierId?: number | null;
}

function searchConds(q: string | undefined, params: Record<string, unknown>): string[] {
  const conds: string[] = [];
  const raw = (q ?? '').trim();
  if (!raw) return conds;
  const tokens = normalizeArabic(raw).split(' ').filter(Boolean).slice(0, 6);
  const parts = tokens.map((t, i) => {
    params[`t${i}`] = `%${t}%`;
    return `p.search_text LIKE @t${i}`;
  });
  params.raw = raw;
  conds.push(`((${parts.join(' AND ')}) OR p.barcode = @raw OR p.sku = @raw OR p.id IN (SELECT product_id FROM product_units WHERE barcode = @raw))`);
  return conds;
}

export function listProducts(ctx: Ctx, query: ProductListQuery = {}) {
  requirePerm(ctx, 'products.view');
  const params: Record<string, unknown> = {};
  const conds = searchConds(query.q, params);
  const status = query.status ?? 'active';
  if (status !== 'all') conds.push(`p.active = ${status === 'active' ? 1 : 0}`);
  if (query.categoryId) { conds.push('p.category_id = @cat'); params.cat = query.categoryId; }
  if (query.brandId) { conds.push('p.brand_id = @brand'); params.brand = query.brandId; }
  if (query.supplierId) { conds.push('p.default_supplier_id = @sup'); params.sup = query.supplierId; }
  const stockExpr = '(SELECT COALESCE(SUM(qty),0) FROM product_stock s WHERE s.product_id = p.id)';
  if (query.stock === 'low') conds.push(`p.min_stock > 0 AND ${stockExpr} <= p.min_stock`);
  if (query.stock === 'out') conds.push(`${stockExpr} <= 0`);
  if (query.stock === 'negative') conds.push(`${stockExpr} < 0`);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const order = { name: 'p.name', stock: 'stock', price: 'p.sell_price DESC', recent: 'p.id DESC' }[query.sort ?? 'name'];
  const showCost = can(ctx, 'reports.cost') || can(ctx, 'products.edit_cost');
  const rows = ctx.db.prepare(
    `SELECT p.id, p.name, p.short_name, p.variant_name, p.barcode, p.sku, p.sell_price, ${showCost ? 'p.avg_cost' : 'NULL AS avg_cost'}, p.min_stock, p.active,
            p.is_weighted, p.track_expiry, p.is_favorite, c.name AS category_name, b.name AS brand_name, u.symbol AS unit_symbol, u.allow_decimal,
            ${stockExpr} AS stock
     FROM products p JOIN units u ON u.id = p.base_unit_id LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
     ${where} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
  ).all(params);
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM products p ${where}`).get(params) as { n: number }).n;
  return { rows, total, page, pageSize };
}

function attachUnits(ctx: Ctx, rows: PosProduct[]): PosProduct[] {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const units = ctx.db.prepare(
    `SELECT pu.id, pu.product_id, pu.unit_id, pu.factor, pu.barcode, pu.sell_price, pu.is_default_sale, pu.is_default_purchase,
            u.name AS unit_name, u.symbol AS unit_symbol, u.allow_decimal
     FROM product_units pu JOIN units u ON u.id = pu.unit_id WHERE pu.product_id IN (${ids.map(() => '?').join(',')}) ORDER BY pu.factor`,
  ).all(...ids) as ProductUnitRow[];
  const byId = new Map<number, ProductUnitRow[]>();
  for (const u of units) {
    if (!byId.has(u.product_id)) byId.set(u.product_id, []);
    byId.get(u.product_id)!.push(u);
  }
  for (const r of rows) r.units = byId.get(r.id) ?? [];
  return rows;
}

const POS_COLS = `p.id, p.name, p.short_name, p.variant_name, p.group_id, g.name AS group_name, p.sell_price, p.is_weighted, p.allow_discount,
  p.base_unit_id, p.category_id, p.barcode, p.sku, p.image, p.is_favorite,
  (SELECT COALESCE(SUM(qty),0) FROM product_stock s WHERE s.product_id = p.id) AS stock`;

/** Parse a scale label barcode (e.g. EAN-13 "2 CCCCC WWWWW K"). */
export function parseScaleBarcode(ctx: Ctx, code: string): { itemCode: string; value: number; mode: 'weight' | 'price' } | null {
  if (!getSetting(ctx.db, 'sales.scaleBarcode.enabled')) return null;
  const prefix = getSetting(ctx.db, 'sales.scaleBarcode.prefix') || '2';
  const codeLen = getSetting(ctx.db, 'sales.scaleBarcode.codeLength') || 5;
  if (!/^\d{13}$/.test(code) || !code.startsWith(prefix)) return null;
  const itemCode = code.slice(prefix.length, prefix.length + codeLen);
  const valueDigits = code.slice(prefix.length + codeLen, 12);
  if (!valueDigits) return null;
  return { itemCode, value: Number(valueDigits), mode: getSetting(ctx.db, 'sales.scaleBarcode.mode') };
}

/** Fast POS lookup: exact barcode/sku first, scale labels, then Arabic-normalized text search. */
export function posSearch(ctx: Ctx, q: string, opts: { categoryId?: number | null; limit?: number; favorites?: boolean } = {}): { exact: boolean; items: PosProduct[] } {
  requirePerm(ctx, 'pos.sell');
  const db = ctx.db;
  const raw = (q ?? '').trim();
  const limit = Math.min(opts.limit ?? 40, 100);
  if (raw) {
    const byBarcode = db.prepare(`SELECT ${POS_COLS} FROM products p LEFT JOIN product_groups g ON g.id = p.group_id WHERE p.active = 1 AND (p.barcode = @c OR p.sku = @c)`).all({ c: raw }) as PosProduct[];
    if (byBarcode.length === 1) return { exact: true, items: attachUnits(ctx, byBarcode) };
    const unitHit = db.prepare(`SELECT pu.product_id, pu.unit_id FROM product_units pu JOIN products p ON p.id = pu.product_id WHERE pu.barcode = ? AND p.active = 1`).get(raw) as { product_id: number; unit_id: number } | undefined;
    if (unitHit) {
      const rows = attachUnits(ctx, db.prepare(`SELECT ${POS_COLS} FROM products p LEFT JOIN product_groups g ON g.id = p.group_id WHERE p.id = ?`).all(unitHit.product_id) as PosProduct[]);
      rows[0].matchedUnitId = unitHit.unit_id;
      return { exact: true, items: rows };
    }
    const scale = parseScaleBarcode(ctx, raw);
    if (scale) {
      const rows = db.prepare(`SELECT ${POS_COLS} FROM products p LEFT JOIN product_groups g ON g.id = p.group_id WHERE p.active = 1 AND (p.sku = @c OR p.barcode = @c OR p.sku = @n)`).all({ c: scale.itemCode, n: String(Number(scale.itemCode)) }) as PosProduct[];
      if (rows.length === 1) {
        attachUnits(ctx, rows);
        if (scale.mode === 'weight') rows[0].matchedQty = scale.value; // grams -> milli kg
        else rows[0].matchedPrice = scale.value; // price in minor units
        return { exact: true, items: rows };
      }
    }
  }
  const params: Record<string, unknown> = {};
  const conds = ['p.active = 1', ...searchConds(raw, params)];
  if (opts.categoryId) { conds.push('p.category_id = @cat'); params.cat = opts.categoryId; }
  if (opts.favorites) conds.push('p.is_favorite = 1');
  const order = opts.favorites ? 'p.favorite_order, p.name' : 'p.is_favorite DESC, p.name';
  const items = db.prepare(
    `SELECT ${POS_COLS} FROM products p LEFT JOIN product_groups g ON g.id = p.group_id WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`,
  ).all(params) as PosProduct[];
  return { exact: false, items: attachUnits(ctx, items) };
}

export function posProduct(ctx: Ctx, id: number): PosProduct {
  requirePerm(ctx, 'pos.sell');
  const rows = ctx.db.prepare(`SELECT ${POS_COLS} FROM products p LEFT JOIN product_groups g ON g.id = p.group_id WHERE p.id = ?`).all(id) as PosProduct[];
  if (!rows.length) throw new AppError('NOT_FOUND');
  return attachUnits(ctx, rows)[0];
}

export function priceHistory(ctx: Ctx, productId: number) {
  requirePerm(ctx, 'products.view');
  const showCost = can(ctx, 'reports.cost') || can(ctx, 'products.edit_cost');
  return ctx.db.prepare(
    `SELECT h.*, u.full_name AS user_name, s.name AS supplier_name FROM price_history h
     LEFT JOIN users u ON u.id = h.user_id LEFT JOIN suppliers s ON s.id = h.supplier_id
     WHERE h.product_id = ? ${showCost ? '' : "AND h.kind = 'sell'"} ORDER BY h.id DESC LIMIT 200`,
  ).all(productId);
}

/** Last purchase price from each supplier for a product (supplier price comparison). */
export function supplierPrices(ctx: Ctx, productId: number) {
  requirePerm(ctx, 'purchases.view');
  return ctx.db.prepare(
    `SELECT s.id AS supplier_id, s.name AS supplier_name, pi.unit_cost, pi.factor, un.name AS unit_name,
            ROUND(pi.landed_total * 1000.0 / pi.base_qty, 4) AS base_cost, pu.purchase_date, COUNT(*) OVER (PARTITION BY s.id) AS times
     FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id JOIN suppliers s ON s.id = pu.supplier_id JOIN units un ON un.id = pi.unit_id
     WHERE pi.product_id = ? AND pi.id = (
       SELECT pi2.id FROM purchase_items pi2 JOIN purchases pu2 ON pu2.id = pi2.purchase_id
       WHERE pi2.product_id = pi.product_id AND pu2.supplier_id = pu.supplier_id ORDER BY pu2.purchase_date DESC, pi2.id DESC LIMIT 1)
     ORDER BY base_cost`,
  ).all(productId);
}

/* ------------------------------------------------------------------ catalog: categories, brands, units */

export function listCategories(ctx: Ctx, opts: { all?: boolean } = {}) {
  return ctx.db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count
     FROM categories c ${opts.all ? '' : 'WHERE c.active = 1'} ORDER BY c.sort_order, c.name`,
  ).all();
}

export function saveCategory(ctx: Ctx, input: { id?: number; name: string; color?: string | null; sortOrder?: number; active?: boolean }) {
  requirePerm(ctx, 'products.manage');
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError('VALIDATION', { detail: 'اسم التصنيف مطلوب' });
  try {
    if (input.id) {
      ctx.db.prepare('UPDATE categories SET name = ?, color = ?, sort_order = ?, active = ? WHERE id = ?').run(name, input.color ?? null, input.sortOrder ?? 0, input.active === false ? 0 : 1, input.id);
      for (const r of ctx.db.prepare('SELECT id FROM products WHERE category_id = ?').all(input.id) as { id: number }[]) buildSearchText(ctx.db, r.id);
      return { id: input.id };
    }
    const info = ctx.db.prepare('INSERT INTO categories(name, color, sort_order) VALUES (?, ?, ?)').run(name, input.color ?? null, input.sortOrder ?? 0);
    return { id: Number(info.lastInsertRowid) };
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new AppError('DUPLICATE_NAME', { name });
    throw e;
  }
}

export function deleteCategory(ctx: Ctx, id: number) {
  requirePerm(ctx, 'products.manage');
  const used = ctx.db.prepare('SELECT 1 FROM products WHERE category_id = ? LIMIT 1').get(id);
  if (used) throw new AppError('IN_USE');
  ctx.db.prepare('DELETE FROM promotions WHERE category_id = ?').run(id);
  ctx.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  return { ok: true };
}

export function listBrands(ctx: Ctx) {
  return ctx.db.prepare('SELECT b.*, (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS product_count FROM brands b ORDER BY b.name').all();
}

export function saveBrand(ctx: Ctx, input: { id?: number; name: string; active?: boolean }) {
  requirePerm(ctx, 'products.manage');
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError('VALIDATION', { detail: 'الاسم مطلوب' });
  try {
    if (input.id) {
      ctx.db.prepare('UPDATE brands SET name = ?, active = ? WHERE id = ?').run(name, input.active === false ? 0 : 1, input.id);
      for (const r of ctx.db.prepare('SELECT id FROM products WHERE brand_id = ?').all(input.id) as { id: number }[]) buildSearchText(ctx.db, r.id);
      return { id: input.id };
    }
    return { id: Number(ctx.db.prepare('INSERT INTO brands(name) VALUES (?)').run(name).lastInsertRowid) };
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new AppError('DUPLICATE_NAME', { name });
    throw e;
  }
}

export function deleteBrand(ctx: Ctx, id: number) {
  requirePerm(ctx, 'products.manage');
  if (ctx.db.prepare('SELECT 1 FROM products WHERE brand_id = ? LIMIT 1').get(id)) throw new AppError('IN_USE');
  ctx.db.prepare('DELETE FROM brands WHERE id = ?').run(id);
  return { ok: true };
}

export function listUnits(ctx: Ctx) {
  return ctx.db.prepare('SELECT * FROM units ORDER BY is_system DESC, id').all() as UnitRow[];
}

export function saveUnit(ctx: Ctx, input: { id?: number; name: string; symbol?: string; kind?: 'count' | 'weight' | 'volume'; allowDecimal?: boolean; active?: boolean }) {
  requirePerm(ctx, 'products.manage');
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError('VALIDATION', { detail: 'اسم الوحدة مطلوب' });
  const kind = input.kind && ['count', 'weight', 'volume'].includes(input.kind) ? input.kind : 'count';
  try {
    if (input.id) {
      ctx.db.prepare('UPDATE units SET name = ?, symbol = ?, kind = ?, allow_decimal = ?, active = ? WHERE id = ?').run(name, input.symbol || name, kind, input.allowDecimal ? 1 : 0, input.active === false ? 0 : 1, input.id);
      return { id: input.id };
    }
    return { id: Number(ctx.db.prepare('INSERT INTO units(name, symbol, kind, allow_decimal) VALUES (?, ?, ?, ?)').run(name, input.symbol || name, kind, input.allowDecimal ? 1 : 0).lastInsertRowid) };
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new AppError('DUPLICATE_NAME', { name });
    throw e;
  }
}

export function listGroups(ctx: Ctx) {
  return ctx.db.prepare('SELECT g.*, (SELECT COUNT(*) FROM products p WHERE p.group_id = g.id AND p.active = 1) AS variant_count FROM product_groups g ORDER BY g.name').all();
}

export function listPriceLists(ctx: Ctx) {
  return ctx.db.prepare('SELECT * FROM price_lists WHERE active = 1 ORDER BY is_default DESC, id').all();
}

export function savePriceList(ctx: Ctx, input: { id?: number; name: string }) {
  requirePerm(ctx, 'settings.manage');
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError('VALIDATION', { detail: 'الاسم مطلوب' });
  if (input.id) {
    ctx.db.prepare('UPDATE price_lists SET name = ? WHERE id = ?').run(name, input.id);
    return { id: input.id };
  }
  const code = `pl${Date.now().toString(36)}`;
  return { id: Number(ctx.db.prepare('INSERT INTO price_lists(code, name) VALUES (?, ?)').run(code, name).lastInsertRowid) };
}

/** Bulk import helper (CSV-like rows) — used by the products import screen. */
export function importProducts(ctx: Ctx, rows: { name: string; barcode?: string; sku?: string; category?: string; unit?: string; sellPrice: number; cost?: number; qty?: number; minStock?: number }[]) {
  requirePerm(ctx, 'products.manage');
  if (!Array.isArray(rows) || rows.length > 20000) throw new AppError('VALIDATION', { detail: 'عدد الصفوف غير صحيح' });
  const results = { created: 0, skipped: 0, errors: [] as { row: number; message: string }[] };
  const units = listUnits(ctx);
  rows.forEach((r, i) => {
    try {
      const unit = units.find((u) => u.name === (r.unit ?? '').trim() || u.symbol === (r.unit ?? '').trim()) ?? units[0];
      let categoryId: number | null = null;
      const catName = (r.category ?? '').trim();
      if (catName) {
        const c = ctx.db.prepare('SELECT id FROM categories WHERE name = ?').get(catName) as { id: number } | undefined;
        categoryId = c ? c.id : saveCategory(ctx, { name: catName }).id;
      }
      createProduct(ctx, {
        name: r.name, barcode: r.barcode || null, sku: r.sku || null, categoryId, baseUnitId: unit.id,
        sellPrice: Math.round(r.sellPrice), cost: r.cost ?? 0, minStock: r.minStock ?? 0, isWeighted: unit.kind === 'weight',
        openingStock: r.qty && r.qty > 0 ? { qty: r.qty, unitCost: r.cost ?? 0 } : null,
      });
      results.created++;
    } catch (e) {
      results.skipped++;
      results.errors.push({ row: i + 1, message: e instanceof AppError ? e.code : 'UNKNOWN' });
    }
  });
  return results;
}
