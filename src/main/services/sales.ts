import { AppError } from '../../shared/errors';
import { formatMoney } from '../../shared/money';
import { formatQty, toBaseQty } from '../../shared/qty';
import { checkoutInput, returnInput, cartInput, type CheckoutInput, type ReturnInput, type CartInput } from '../../shared/schemas';
import {
  type Ctx, addDays, audit, can, defaultLocationId, docNo, getSetting, requirePerm, requirePermOrApproval, requireUser, today, ts, tx,
} from './context';
import { applyMovement, issueStock, restoreBatches, sellableStock, updateAverageCost } from './inventory';
import { postLedger } from './parties';
import { missingApprovals, priceCart } from './pricing';
import { addCashMovement, currentShift, expectedCash, shiftForCash } from './shifts';

function currency(ctx: Ctx) {
  return { code: getSetting(ctx.db, 'currency.code'), symbol: getSetting(ctx.db, 'currency.symbol'), digits: getSetting(ctx.db, 'ui.digits') };
}

function isDayClosed(ctx: Ctx, date: string): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM day_closings WHERE business_date = ?').get(date);
}

export function quoteCart(ctx: Ctx, cart: CartInput) {
  requirePerm(ctx, 'pos.sell');
  const priced = priceCart(ctx, cart);
  assertSellable(ctx, priced.lines);
  return { ...priced, missingApprovals: missingApprovals(ctx, priced) };
}

/** Warn the cashier while the cart is being built: expired goods can never be sold (checkout enforces it too). */
function assertSellable(ctx: Ctx, lines: { productId: number; baseQty: number }[]) {
  const loc = defaultLocationId(ctx.db);
  const need = new Map<number, number>();
  for (const l of lines) need.set(l.productId, (need.get(l.productId) ?? 0) + l.baseQty);
  for (const [pid, q] of need) {
    const st = sellableStock(ctx, pid, loc);
    if (st.expired > 0 && q > st.sellable) {
      const name = (ctx.db.prepare('SELECT name FROM products WHERE id = ?').get(pid) as { name: string }).name;
      throw new AppError('EXPIRED_STOCK', { name, available: formatQty(st.sellable), expired: formatQty(st.expired) });
    }
  }
}

/**
 * Completes a sale atomically: invoice, lines, stock movements (with COGS
 * snapshot), payments, drawer cash, customer debt. All-or-nothing.
 */
export function checkout(ctx: Ctx, raw: CheckoutInput) {
  requirePerm(ctx, 'pos.sell');
  const user = requireUser(ctx);
  const input = checkoutInput.parse(raw);
  if (!input.cart.lines.length) throw new AppError('EMPTY_CART');
  if (input.clientRef) {
    const dup = ctx.db.prepare('SELECT id FROM sales WHERE client_ref = ?').get(input.clientRef) as { id: number } | undefined;
    if (dup) return getSale(ctx, dup.id); // idempotent: double-click / retry never creates two invoices
  }
  return tx(ctx, () => {
    const priced = priceCart(ctx, input.cart);
    const missing = missingApprovals(ctx, priced);
    if (missing.length) throw new AppError('APPROVAL_REQUIRED', { permission: missing[0] });
    const needsAny = priced.needsApproval.priceOverride || priced.needsApproval.largeDiscount || priced.needsApproval.discount;
    const approvedBy = needsAny && ctx.approver && ctx.approver.id !== user.id ? ctx.approver.id : null;

    const shift = shiftForCash(ctx);
    const sum = (m: string) => input.payments.filter((p) => p.method === m).reduce((a, p) => a + p.amount, 0);
    const cash = sum('cash');
    const card = sum('card');
    const wallet = sum('wallet');
    let credit = sum('credit');
    const total = priced.total;
    if (card + wallet + credit > total) throw new AppError('OVERPAID_NON_CASH');
    const covered = cash + card + wallet + credit;
    if (covered < total) {
      if (!priced.customerId) throw new AppError('PAYMENT_INSUFFICIENT');
      credit += total - covered; // remaining becomes customer debt (validated below)
    }
    const change = Math.max(0, cash + card + wallet + credit - total);
    if (change > cash) throw new AppError('CHANGE_FROM_CARD');
    const cashNet = cash - change;

    let creditApprover: number | null = null;
    if (credit > 0) {
      if (!getSetting(ctx.db, 'features.creditSales')) throw new AppError('CREDIT_DISABLED');
      if (!priced.customerId) throw new AppError('CUSTOMER_REQUIRED');
      creditApprover = requirePermOrApproval(ctx, 'pos.credit_sale');
      const c = ctx.db.prepare('SELECT name, balance, credit_limit, active FROM customers WHERE id = ?').get(priced.customerId) as { name: string; balance: number; credit_limit: number | null; active: number };
      if (c.credit_limit !== null && c.balance + credit > c.credit_limit) {
        throw new AppError('CREDIT_LIMIT', { name: c.name, limit: formatMoney(c.credit_limit, currency(ctx)) });
      }
    }

    const allowNegative = getSetting(ctx.db, 'sales.allowNegativeStock') || can(ctx, 'pos.negative_stock');
    const locationId = defaultLocationId(ctx.db);
    const prefix = getSetting(ctx.db, 'sales.invoicePrefix') || '';
    const invoiceNo = docNo(ctx.db, 'invoice', prefix, 6);
    const now = ts(ctx);
    const date = today(ctx);
    const info = ctx.db.prepare(
      `INSERT INTO sales(invoice_no, shift_id, user_id, customer_id, location_id, price_list_id, status, subtotal, line_discount, invoice_discount, rounding,
         tax_total, total, net_revenue, paid, change_due, credit_amount, cogs, items_count, discount_by, approved_by, quotation_id, client_ref, note, business_date, created_at)
       VALUES (@no, @shift, @user, @cust, @loc, @pl, 'completed', @subtotal, @ld, @id, @rounding, @tax, @total, @net, @paid, @change, @credit, 0, @count,
         @dby, @appr, @quote, @ref, @note, @date, @now)`,
    ).run({
      no: invoiceNo, shift: shift?.id ?? null, user: user.id, cust: priced.customerId, loc: locationId, pl: priced.priceListId,
      subtotal: priced.subtotal, ld: priced.promoDiscount + priced.lineDiscount, id: priced.invoiceDiscount, rounding: priced.rounding,
      tax: priced.taxTotal, total, net: priced.netRevenue, paid: cash + card + wallet, change, credit, count: priced.lines.length,
      dby: priced.manualDiscountTotal > 0 ? user.id : null, appr: approvedBy ?? creditApprover, quote: input.quotationId ?? null,
      ref: input.clientRef ?? null, note: input.note ?? null, date, now,
    });
    const saleId = Number(info.lastInsertRowid);
    const insItem = ctx.db.prepare(
      `INSERT INTO sale_items(sale_id, product_id, unit_id, product_name, unit_name, qty, factor, base_qty, unit_price, original_price, gross, discount,
         promo_discount, promotion_id, invoice_discount_share, tax, tax_rate, total, net_revenue, unit_cost, cost_total)
       VALUES (@sale, @pid, @uid, @pname, @uname, @qty, @factor, @base, @price, @orig, @gross, @disc, @promo, @promoId, @share, @tax, @rate, @total, @net, @cost, @costTotal)`,
    );
    const insBatch = ctx.db.prepare('INSERT INTO sale_item_batches(sale_item_id, batch_id, qty) VALUES (?, ?, ?)');
    let cogs = 0;
    for (const l of priced.lines) {
      const out = issueStock(ctx, { productId: l.productId, locationId, qty: l.baseQty, type: 'sale', refType: 'sale', refId: saleId, allowNegative, sellableOnly: true });
      cogs += out.costTotal;
      const itemId = Number(insItem.run({
        sale: saleId, pid: l.productId, uid: l.unitId, pname: l.productName, uname: l.unitName, qty: l.qty, factor: l.factor, base: l.baseQty,
        price: l.unitPrice, orig: l.listPrice, gross: l.gross, disc: l.discount, promo: l.promoDiscount, promoId: l.promotionId,
        share: l.invoiceDiscountShare, tax: l.tax, rate: l.taxRate, total: l.total, net: l.netRevenue, cost: out.unitCost, costTotal: out.costTotal,
      }).lastInsertRowid);
      for (const b of out.batches) insBatch.run(itemId, b.batchId, b.qty);
    }
    ctx.db.prepare('UPDATE sales SET cogs = ? WHERE id = ?').run(cogs, saleId);
    const insPay = ctx.db.prepare('INSERT INTO sale_payments(sale_id, method, amount) VALUES (?, ?, ?)');
    if (cashNet > 0) insPay.run(saleId, 'cash', cashNet);
    if (card > 0) insPay.run(saleId, 'card', card);
    if (wallet > 0) insPay.run(saleId, 'wallet', wallet);
    if (credit > 0) insPay.run(saleId, 'credit', credit);
    if (shift && cashNet !== 0) addCashMovement(ctx, shift.id, 'sale', cashNet, { type: 'sale', id: saleId }, invoiceNo);
    if (credit > 0) postLedger(ctx, 'customer', priced.customerId!, 'sale', credit, { type: 'sale', id: saleId }, `فاتورة ${invoiceNo}`);
    if (input.heldId) ctx.db.prepare('DELETE FROM held_sales WHERE id = ?').run(input.heldId);
    if (input.quotationId) ctx.db.prepare(`UPDATE quotations SET status = 'converted', sale_id = ? WHERE id = ? AND status = 'open'`).run(saleId, input.quotationId);
    if (priced.manualDiscountTotal > 0) {
      audit(ctx, 'sale.discount', 'sale', saleId, undefined, { amount: priced.manualDiscountTotal, pct: priced.discountPct, invoiceNo }, null, approvedBy);
    }
    for (const l of priced.lines.filter((x) => x.priceOverridden)) {
      audit(ctx, 'sale.price_override', 'sale', saleId, { price: l.listPrice }, { price: l.unitPrice, product: l.productName, invoiceNo }, null, approvedBy);
    }
    if (credit > 0) audit(ctx, 'sale.credit', 'sale', saleId, undefined, { amount: credit, customerId: priced.customerId, invoiceNo }, null, creditApprover);
    return getSale(ctx, saleId);
  });
}

export function getSale(ctx: Ctx, id: number): any {
  const user = requireUser(ctx);
  const sale = ctx.db.prepare(
    `SELECT s.*, u.full_name AS cashier_name, c.name AS customer_name, c.phone AS customer_phone, c.balance AS customer_balance,
            vu.full_name AS voided_by_name, au.full_name AS approved_by_name
     FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
     LEFT JOIN users vu ON vu.id = s.voided_by LEFT JOIN users au ON au.id = s.approved_by WHERE s.id = ?`,
  ).get(id) as Record<string, any> | undefined;
  if (!sale) throw new AppError('NOT_FOUND');
  if (sale.user_id !== user.id && !can(ctx, 'sales.view_all') && !can(ctx, 'pos.return')) throw new AppError('FORBIDDEN');
  const items = ctx.db.prepare(
    `SELECT si.*, un.allow_decimal, un.symbol AS unit_symbol, bu.symbol AS base_unit_symbol FROM sale_items si JOIN units un ON un.id = si.unit_id
     JOIN products p ON p.id = si.product_id JOIN units bu ON bu.id = p.base_unit_id WHERE si.sale_id = ? ORDER BY si.id`,
  ).all(id) as Record<string, any>[];
  const payments = ctx.db.prepare('SELECT method, amount FROM sale_payments WHERE sale_id = ?').all(id);
  const returns = ctx.db.prepare(
    `SELECT r.id, r.return_no, r.total, r.refund_method, r.created_at, u.full_name AS user_name FROM sale_returns r JOIN users u ON u.id = r.user_id WHERE r.sale_id = ? ORDER BY r.id`,
  ).all(id);
  if (!can(ctx, 'reports.cost')) {
    sale.cogs = null;
    for (const it of items) { it.unit_cost = null; it.cost_total = null; }
  }
  return { ...sale, items, payments, returns };
}

export function listSales(ctx: Ctx, opts: { from: string; to: string; q?: string; userId?: number | null; customerId?: number | null; status?: string | null; method?: string | null; page?: number; pageSize?: number }) {
  requirePerm(ctx, 'sales.view');
  const user = requireUser(ctx);
  const conds = ['s.business_date BETWEEN @from AND @to'];
  const params: Record<string, unknown> = { from: opts.from, to: opts.to };
  if (!can(ctx, 'sales.view_all')) { conds.push('s.user_id = @me'); params.me = user.id; }
  else if (opts.userId) { conds.push('s.user_id = @uid'); params.uid = opts.userId; }
  if (opts.customerId) { conds.push('s.customer_id = @cid'); params.cid = opts.customerId; }
  if (opts.status) { conds.push('s.status = @st'); params.st = opts.status; }
  if (opts.method) { conds.push('EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.method = @m)'); params.m = opts.method; }
  if (opts.q?.trim()) { conds.push('(s.invoice_no LIKE @q OR c.name LIKE @q OR c.phone LIKE @q)'); params.q = `%${opts.q.trim()}%`; }
  const pageSize = Math.min(opts.pageSize ?? 50, 200);
  const page = Math.max(opts.page ?? 1, 1);
  const where = conds.join(' AND ');
  const rows = ctx.db.prepare(
    `SELECT s.id, s.invoice_no, s.status, s.total, s.paid, s.credit_amount, s.items_count, s.line_discount + s.invoice_discount AS discount, s.created_at,
            u.full_name AS cashier_name, c.name AS customer_name,
            (SELECT COALESCE(SUM(total),0) FROM sale_returns r WHERE r.sale_id = s.id) AS returned,
            (SELECT GROUP_CONCAT(method) FROM sale_payments sp WHERE sp.sale_id = s.id) AS methods
     FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ${where} ORDER BY s.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
  ).all(params);
  const agg = ctx.db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN s.status='completed' THEN s.total END),0) AS total FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE ${where}`,
  ).get(params) as { count: number; total: number };
  return { rows, total: agg.count, sum: agg.total, page, pageSize };
}

export function findSaleByNo(ctx: Ctx, invoiceNo: string): any {
  const row = ctx.db.prepare('SELECT id FROM sales WHERE invoice_no = ?').get(String(invoiceNo).trim()) as { id: number } | undefined;
  if (!row) throw new AppError('NOT_FOUND');
  return getSale(ctx, row.id);
}

/** Void a same-day invoice: reverses stock, cash and customer debt with ledger entries. */
export function voidSale(ctx: Ctx, input: { saleId: number; reason: string }) {
  const approvedBy = requirePermOrApproval(ctx, 'pos.void');
  const reason = String(input.reason ?? '').trim();
  if (!reason) throw new AppError('VALIDATION', { detail: 'سبب الإلغاء مطلوب' });
  return tx(ctx, () => {
    const s = ctx.db.prepare('SELECT * FROM sales WHERE id = ?').get(input.saleId) as Record<string, any> | undefined;
    if (!s) throw new AppError('NOT_FOUND');
    if (s.status === 'voided') throw new AppError('SALE_ALREADY_VOIDED');
    if (ctx.db.prepare('SELECT 1 FROM sale_returns WHERE sale_id = ? LIMIT 1').get(s.id)) throw new AppError('SALE_HAS_RETURNS');
    if (s.business_date !== today(ctx)) throw new AppError('VOID_NOT_TODAY');
    if (isDayClosed(ctx, s.business_date)) throw new AppError('DAY_ALREADY_CLOSED');
    const items = ctx.db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(s.id) as Record<string, any>[];
    for (const it of items) {
      updateAverageCost(ctx, it.product_id, it.base_qty, it.unit_cost);
      applyMovement(ctx, { productId: it.product_id, locationId: s.location_id, type: 'void', qty: it.base_qty, unitCost: it.unit_cost, refType: 'sale', refId: s.id, note: reason, allowNegative: true });
      const allocs = ctx.db.prepare('SELECT batch_id AS batchId, qty FROM sale_item_batches WHERE sale_item_id = ?').all(it.id) as { batchId: number; qty: number }[];
      restoreBatches(ctx, allocs);
    }
    const cashPaid = (ctx.db.prepare(`SELECT COALESCE(SUM(amount),0) AS a FROM sale_payments WHERE sale_id = ? AND method = 'cash'`).get(s.id) as { a: number }).a;
    if (cashPaid > 0) {
      let shift = currentShift(ctx);
      if (!shift && s.shift_id) {
        const orig = ctx.db.prepare(`SELECT * FROM shifts WHERE id = ? AND status = 'open'`).get(s.shift_id) as any;
        shift = orig ?? null;
      }
      if (!shift && getSetting(ctx.db, 'sales.requireShift')) throw new AppError('SHIFT_REQUIRED');
      if (shift) addCashMovement(ctx, shift.id, 'void', -cashPaid, { type: 'sale', id: s.id }, s.invoice_no);
    }
    if (s.credit_amount > 0 && s.customer_id) postLedger(ctx, 'customer', s.customer_id, 'void', -s.credit_amount, { type: 'sale', id: s.id }, `إلغاء فاتورة ${s.invoice_no}`);
    ctx.db.prepare(`UPDATE sales SET status = 'voided', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?`).run(ts(ctx), ctx.user!.id, reason, s.id);
    audit(ctx, 'sale.void', 'sale', s.id, { total: s.total, invoiceNo: s.invoice_no }, { status: 'voided' }, reason, approvedBy);
    return getSale(ctx, s.id);
  });
}

/** Sale return (partial or full). Revenue, COGS, stock, cash and customer balances are all reversed proportionally. */
export function createReturn(ctx: Ctx, raw: ReturnInput) {
  if (!getSetting(ctx.db, 'sales.allowReturns')) throw new AppError('RETURNS_DISABLED');
  const approvedBy = requirePermOrApproval(ctx, 'pos.return');
  const input = returnInput.parse(raw);
  return tx(ctx, () => {
    const s = ctx.db.prepare('SELECT * FROM sales WHERE id = ?').get(input.saleId) as Record<string, any> | undefined;
    if (!s) throw new AppError('NOT_FOUND');
    if (s.status !== 'completed') throw new AppError('SALE_ALREADY_VOIDED');
    const days = getSetting(ctx.db, 'sales.returnDays');
    if (days > 0 && addDays(s.business_date, days) < today(ctx)) throw new AppError('RETURN_PERIOD_EXPIRED', { days });
    const prevStmt = ctx.db.prepare('SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(net_revenue),0) AS net, COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(cost_total),0) AS cost FROM sale_return_items WHERE sale_item_id = ?');
    type Line = { item: Record<string, any>; qty: number; base: number; total: number; net: number; tax: number; cost: number; restock: boolean };
    const lines: Line[] = [];
    for (const r of input.items) {
      const it = ctx.db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(r.saleItemId, s.id) as Record<string, any> | undefined;
      if (!it) throw new AppError('NOT_FOUND');
      const base = toBaseQty(r.qty, it.factor);
      const remaining = it.base_qty - it.returned_base_qty;
      if (base <= 0) continue;
      if (base > remaining) throw new AppError('RETURN_QTY_EXCEEDED', { name: it.product_name });
      const prev = prevStmt.get(it.id) as { total: number; net: number; tax: number; cost: number };
      const final = base === remaining;
      const share = (v: number) => Math.round((v * base) / it.base_qty);
      const total = final ? it.total - prev.total : share(it.total);
      const tax = final ? it.tax - prev.tax : share(it.tax);
      const fullCost = final ? it.cost_total - prev.cost : share(it.cost_total);
      lines.push({ item: it, qty: r.qty, base, total, net: total - tax, tax, cost: r.restock ? fullCost : 0, restock: r.restock });
    }
    if (!lines.length) throw new AppError('NOTHING_TO_RETURN');
    const total = lines.reduce((a, l) => a + l.total, 0);
    const net = lines.reduce((a, l) => a + l.net, 0);
    const tax = lines.reduce((a, l) => a + l.tax, 0);
    const cogs = lines.reduce((a, l) => a + l.cost, 0);
    let shiftId: number | null = null;
    if (input.refundMethod === 'cash') {
      const shift = shiftForCash(ctx, { mandatory: getSetting(ctx.db, 'sales.requireShift') });
      if (shift) {
        if (expectedCash(ctx, shift.id) < total) throw new AppError('CASH_INSUFFICIENT');
        shiftId = shift.id;
      }
    } else {
      shiftId = currentShift(ctx)?.id ?? null;
    }
    if (input.refundMethod === 'credit' && !s.customer_id) throw new AppError('CUSTOMER_REQUIRED');
    const no = docNo(ctx.db, 'sale_return', 'R-', 6);
    const info = ctx.db.prepare(
      `INSERT INTO sale_returns(return_no, sale_id, shift_id, user_id, customer_id, location_id, total, net_revenue, tax_total, cogs, refund_method, reason, approved_by, business_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(no, s.id, shiftId, ctx.user!.id, s.customer_id, s.location_id, total, net, tax, cogs, input.refundMethod, input.reason ?? null, approvedBy, today(ctx), ts(ctx));
    const retId = Number(info.lastInsertRowid);
    const insItem = ctx.db.prepare(
      `INSERT INTO sale_return_items(return_id, sale_item_id, product_id, qty, base_qty, total, net_revenue, tax, cost_total, restock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines) {
      insItem.run(retId, l.item.id, l.item.product_id, l.qty, l.base, l.total, l.net, l.tax, l.cost, l.restock ? 1 : 0);
      ctx.db.prepare('UPDATE sale_items SET returned_base_qty = returned_base_qty + ? WHERE id = ?').run(l.base, l.item.id);
      if (l.restock) {
        updateAverageCost(ctx, l.item.product_id, l.base, l.item.unit_cost);
        applyMovement(ctx, { productId: l.item.product_id, locationId: s.location_id, type: 'sale_return', qty: l.base, unitCost: l.item.unit_cost, refType: 'sale_return', refId: retId, note: input.reason, allowNegative: true });
        // put quantity back into the batches it came from (latest expiry first)
        const allocs = ctx.db.prepare(
          `SELECT sib.batch_id AS batchId, sib.qty FROM sale_item_batches sib JOIN batches b ON b.id = sib.batch_id WHERE sib.sale_item_id = ? ORDER BY b.expiry_date DESC`,
        ).all(l.item.id) as { batchId: number; qty: number }[];
        let left = l.base;
        const restore: { batchId: number; qty: number }[] = [];
        for (const a of allocs) {
          if (left <= 0) break;
          const q = Math.min(a.qty, left);
          restore.push({ batchId: a.batchId, qty: q });
          left -= q;
        }
        restoreBatches(ctx, restore);
      }
    }
    if (input.refundMethod === 'cash' && shiftId) addCashMovement(ctx, shiftId, 'refund', -total, { type: 'sale_return', id: retId }, no);
    if (input.refundMethod === 'credit') postLedger(ctx, 'customer', s.customer_id, 'return', -total, { type: 'sale_return', id: retId }, `مرتجع ${no}`);
    audit(ctx, 'sale.return', 'sale', s.id, undefined, { returnNo: no, total, refund: input.refundMethod }, input.reason, approvedBy);
    return getReturn(ctx, retId);
  });
}

export function getReturn(ctx: Ctx, id: number): any {
  requireUser(ctx);
  const r = ctx.db.prepare(
    `SELECT r.*, s.invoice_no, u.full_name AS user_name, c.name AS customer_name FROM sale_returns r JOIN sales s ON s.id = r.sale_id
     JOIN users u ON u.id = r.user_id LEFT JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`,
  ).get(id) as Record<string, any> | undefined;
  if (!r) throw new AppError('NOT_FOUND');
  const items = ctx.db.prepare(
    `SELECT ri.*, si.product_name, si.unit_name, si.unit_price FROM sale_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.return_id = ?`,
  ).all(id);
  return { ...r, items };
}

export function listReturns(ctx: Ctx, opts: { from: string; to: string }) {
  requirePerm(ctx, 'sales.view');
  const user = requireUser(ctx);
  const own = !can(ctx, 'sales.view_all');
  return ctx.db.prepare(
    `SELECT r.id, r.return_no, r.total, r.refund_method, r.reason, r.created_at, s.invoice_no, u.full_name AS user_name, c.name AS customer_name,
            (SELECT COUNT(*) FROM sale_return_items ri WHERE ri.return_id = r.id) AS items_count
     FROM sale_returns r JOIN sales s ON s.id = r.sale_id JOIN users u ON u.id = r.user_id LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.business_date BETWEEN @from AND @to ${own ? 'AND r.user_id = @me' : ''} ORDER BY r.id DESC LIMIT 500`,
  ).all({ from: opts.from, to: opts.to, me: user.id });
}

/* ------------------------------------------------------------------ held sales */

export function holdSale(ctx: Ctx, input: { cart: CartInput; label?: string | null }) {
  requirePerm(ctx, 'pos.sell');
  const cart = cartInput.parse(input.cart);
  if (!cart.lines.length) throw new AppError('EMPTY_CART');
  const priced = priceCart(ctx, cart);
  const info = ctx.db.prepare(
    `INSERT INTO held_sales(user_id, label, customer_id, payload, total, items_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ctx.user!.id, input.label?.slice(0, 100) ?? null, cart.customerId ?? null, JSON.stringify(cart), priced.total, cart.lines.length, ts(ctx));
  return { id: Number(info.lastInsertRowid) };
}

export function listHeld(ctx: Ctx) {
  requirePerm(ctx, 'pos.sell');
  const all = can(ctx, 'sales.view_all');
  return ctx.db.prepare(
    `SELECT h.id, h.label, h.total, h.items_count, h.created_at, u.full_name AS user_name, c.name AS customer_name
     FROM held_sales h JOIN users u ON u.id = h.user_id LEFT JOIN customers c ON c.id = h.customer_id
     ${all ? '' : 'WHERE h.user_id = @me'} ORDER BY h.id DESC`,
  ).all({ me: ctx.user!.id });
}

export function getHeld(ctx: Ctx, id: number) {
  requirePerm(ctx, 'pos.sell');
  const h = ctx.db.prepare('SELECT * FROM held_sales WHERE id = ?').get(id) as { id: number; user_id: number; payload: string; label: string | null } | undefined;
  if (!h) throw new AppError('NOT_FOUND');
  if (h.user_id !== ctx.user!.id && !can(ctx, 'sales.view_all')) throw new AppError('FORBIDDEN');
  return { id: h.id, label: h.label, cart: JSON.parse(h.payload) as CartInput };
}

export function deleteHeld(ctx: Ctx, id: number) {
  getHeld(ctx, id);
  ctx.db.prepare('DELETE FROM held_sales WHERE id = ?').run(id);
  return { ok: true };
}

/* ------------------------------------------------------------------ quotations */

export function createQuotation(ctx: Ctx, input: { cart: CartInput; customerName?: string | null; validDays?: number; note?: string | null }) {
  requirePerm(ctx, 'quotations.manage');
  if (!getSetting(ctx.db, 'features.quotations')) throw new AppError('FEATURE_DISABLED');
  const cart = cartInput.parse(input.cart);
  if (!cart.lines.length) throw new AppError('EMPTY_CART');
  const priced = priceCart(ctx, cart);
  return tx(ctx, () => {
    const no = docNo(ctx.db, 'quotation', 'Q-', 5);
    const valid = input.validDays && input.validDays > 0 ? addDays(today(ctx), input.validDays) : null;
    const info = ctx.db.prepare(
      `INSERT INTO quotations(quote_no, customer_id, customer_name, user_id, payload, total, valid_until, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(no, cart.customerId ?? null, input.customerName ?? null, ctx.user!.id, JSON.stringify(cart), priced.total, valid, input.note ?? null, ts(ctx));
    return getQuotation(ctx, Number(info.lastInsertRowid));
  });
}

export function getQuotation(ctx: Ctx, id: number): any {
  requirePerm(ctx, 'quotations.manage');
  const q = ctx.db.prepare(
    `SELECT q.*, u.full_name AS user_name, c.name AS customer_full_name, s.invoice_no FROM quotations q JOIN users u ON u.id = q.user_id
     LEFT JOIN customers c ON c.id = q.customer_id LEFT JOIN sales s ON s.id = q.sale_id WHERE q.id = ?`,
  ).get(id) as Record<string, any> | undefined;
  if (!q) throw new AppError('NOT_FOUND');
  const cart = JSON.parse(q.payload) as CartInput;
  let priced = null;
  try { priced = priceCart(ctx, cart); } catch { priced = null; }
  return { ...q, cart, priced };
}

export function listQuotations(ctx: Ctx) {
  requirePerm(ctx, 'quotations.manage');
  return ctx.db.prepare(
    `SELECT q.id, q.quote_no, q.status, q.total, q.valid_until, q.created_at, COALESCE(c.name, q.customer_name) AS customer_name, u.full_name AS user_name, s.invoice_no
     FROM quotations q JOIN users u ON u.id = q.user_id LEFT JOIN customers c ON c.id = q.customer_id LEFT JOIN sales s ON s.id = q.sale_id ORDER BY q.id DESC LIMIT 500`,
  ).all();
}

export function cancelQuotation(ctx: Ctx, id: number) {
  requirePerm(ctx, 'quotations.manage');
  const r = ctx.db.prepare(`UPDATE quotations SET status = 'cancelled' WHERE id = ? AND status = 'open'`).run(id);
  if (!r.changes) throw new AppError('NOT_FOUND');
  return { ok: true };
}
