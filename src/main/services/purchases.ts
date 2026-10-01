import { AppError } from '../../shared/errors';
import { toBaseQty } from '../../shared/qty';
import { purchaseInput, purchaseOrderInput, purchaseReturnInput, type PurchaseInput, type PurchaseOrderInput, type PurchaseReturnInput } from '../../shared/schemas';
import { type Ctx, audit, defaultLocationId, docNo, requirePerm, today, ts, tx } from './context';
import { issueFromBatch, issueStock, receiveStock, type BatchRow } from './inventory';
import { postLedger } from './parties';
import { allocate } from './pricing';
import { logPrice } from './products';
import { addCashMovement, expectedCash, shiftForCash } from './shifts';

function unitInfo(ctx: Ctx, productId: number, unitId: number) {
  const r = ctx.db.prepare(
    `SELECT pu.factor, u.name AS unit_name, u.allow_decimal, p.name AS product_name, p.variant_name, p.avg_cost, p.last_cost, p.sell_price, p.active
     FROM product_units pu JOIN units u ON u.id = pu.unit_id JOIN products p ON p.id = pu.product_id WHERE pu.product_id = ? AND pu.unit_id = ?`,
  ).get(productId, unitId) as { factor: number; unit_name: string; allow_decimal: number; product_name: string; variant_name: string | null; avg_cost: number; last_cost: number; sell_price: number; active: number } | undefined;
  if (!r) throw new AppError('INVALID_UNIT');
  return r;
}

/**
 * Posts a purchase invoice: increases stock, updates weighted average cost
 * using the landed cost (after invoice discount + tax allocation), records
 * supplier debt and payment.
 */
export function createPurchase(ctx: Ctx, raw: PurchaseInput) {
  requirePerm(ctx, 'purchases.manage');
  const input = purchaseInput.parse(raw);
  return tx(ctx, () => {
    const locationId = input.locationId ?? defaultLocationId(ctx.db);
    const lines = input.lines.map((l) => {
      const u = unitInfo(ctx, l.productId, l.unitId);
      if (!u.allow_decimal && l.qty % 1000 !== 0) throw new AppError('DECIMAL_NOT_ALLOWED', { name: u.product_name });
      const gross = Math.round((l.unitCost * l.qty) / 1000);
      if (l.discount > gross) throw new AppError('DISCOUNT_EXCEEDS_TOTAL');
      return { ...l, u, base: toBaseQty(l.qty, u.factor), total: gross - l.discount };
    });
    const subtotal = lines.reduce((a, l) => a + l.total, 0);
    if (input.discount > subtotal) throw new AppError('DISCOUNT_EXCEEDS_TOTAL');
    const total = subtotal - input.discount + input.tax;
    if (input.paid > total) throw new AppError('PAID_EXCEEDS_TOTAL');
    if (input.paid < total && !input.supplierId) throw new AppError('VALIDATION', { detail: 'الشراء الآجل يحتاج اختيار مورد' });
    // landed cost allocation: invoice-level discount reduces and tax increases each line's cost
    const discShares = allocate(input.discount, lines.map((l) => l.total));
    const taxShares = allocate(input.tax, lines.map((l) => l.total));
    let shiftId: number | null = null;
    if (input.paid > 0 && input.paymentMethod === 'cash' && input.paidFromDrawer) {
      const s = shiftForCash(ctx, { mandatory: true })!;
      if (expectedCash(ctx, s.id) < input.paid) throw new AppError('CASH_INSUFFICIENT');
      shiftId = s.id;
    }
    const no = docNo(ctx.db, 'purchase', 'P-', 6);
    const date = input.purchaseDate ?? today(ctx);
    const info = ctx.db.prepare(
      `INSERT INTO purchases(purchase_no, supplier_id, supplier_invoice_no, location_id, po_id, subtotal, discount, tax, total, paid, paid_from_drawer, notes, user_id, purchase_date, business_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(no, input.supplierId ?? null, input.supplierInvoiceNo ?? null, locationId, input.poId ?? null, subtotal, input.discount, input.tax, total, input.paid,
      shiftId ? 1 : 0, input.notes ?? null, ctx.user?.id ?? null, date, today(ctx), ts(ctx));
    const purchaseId = Number(info.lastInsertRowid);
    const insItem = ctx.db.prepare(
      `INSERT INTO purchase_items(purchase_id, product_id, unit_id, product_name, unit_name, qty, factor, base_qty, unit_cost, discount, total, landed_total, batch_id, batch_no, expiry_date)
       VALUES (@pid, @prod, @unit, @pname, @uname, @qty, @factor, @base, @cost, @disc, @total, @landed, @batch, @bno, @exp)`,
    );
    lines.forEach((l, i) => {
      const landed = l.total - discShares[i] + taxShares[i];
      const baseCost = l.base > 0 ? (landed * 1000) / l.base : 0;
      const { batchId } = receiveStock(ctx, {
        productId: l.productId, locationId, qty: l.base, unitCost: baseCost, type: 'purchase', refType: 'purchase', refId: purchaseId,
        batch: { batchNo: l.batchNo, expiryDate: l.expiryDate, supplierId: input.supplierId ?? null },
      });
      const itemInfo = insItem.run({
        pid: purchaseId, prod: l.productId, unit: l.unitId, pname: l.u.variant_name ? `${l.u.product_name} ${l.u.variant_name}` : l.u.product_name,
        uname: l.u.unit_name, qty: l.qty, factor: l.u.factor, base: l.base, cost: l.unitCost, disc: l.discount, total: l.total, landed,
        batch: batchId, bno: l.batchNo ?? null, exp: l.expiryDate ?? null,
      });
      if (batchId) ctx.db.prepare('UPDATE batches SET purchase_item_id = ? WHERE id = ?').run(Number(itemInfo.lastInsertRowid), batchId);
      const rounded = Math.round(baseCost * 10000) / 10000;
      if (Math.abs(rounded - l.u.last_cost) > 0.0001) logPrice(ctx, l.productId, 'cost', l.u.last_cost || null, rounded, { supplierId: input.supplierId, refType: 'purchase', refId: purchaseId });
      ctx.db.prepare('UPDATE products SET last_cost = ?, default_supplier_id = COALESCE(default_supplier_id, ?), updated_at = ? WHERE id = ?').run(rounded, input.supplierId ?? null, ts(ctx), l.productId);
      if (l.newSellPrice !== null && l.newSellPrice !== undefined && l.newSellPrice !== l.u.sell_price) {
        requirePerm(ctx, 'products.edit_price');
        ctx.db.prepare('UPDATE products SET sell_price = ? WHERE id = ?').run(l.newSellPrice, l.productId);
        logPrice(ctx, l.productId, 'sell', l.u.sell_price, l.newSellPrice, { refType: 'purchase', refId: purchaseId });
        audit(ctx, 'product.price_change', 'product', l.productId, { sellPrice: l.u.sell_price }, { sellPrice: l.newSellPrice }, `من فاتورة شراء ${no}`);
      }
      if (l.poItemId) ctx.db.prepare('UPDATE purchase_order_items SET received_qty = received_qty + ? WHERE id = ?').run(l.qty, l.poItemId);
    });
    if (input.supplierId) {
      postLedger(ctx, 'supplier', input.supplierId, 'purchase', total, { type: 'purchase', id: purchaseId }, `فاتورة شراء ${no}${input.supplierInvoiceNo ? ` (${input.supplierInvoiceNo})` : ''}`);
      if (input.paid > 0) {
        const payNo = docNo(ctx.db, 'payment', 'PY-');
        const pay = ctx.db.prepare(
          `INSERT INTO party_payments(payment_no, party_type, party_id, amount, method, shift_id, note, user_id, business_date, created_at) VALUES (?, 'supplier', ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(payNo, input.supplierId, input.paid, input.paymentMethod, shiftId, `دفعة مع فاتورة ${no}`, ctx.user?.id ?? null, today(ctx), ts(ctx));
        postLedger(ctx, 'supplier', input.supplierId, 'payment', -input.paid, { type: 'payment', id: Number(pay.lastInsertRowid) }, `دفعة مع فاتورة ${no}`);
      }
    }
    if (shiftId) addCashMovement(ctx, shiftId, 'purchase', -input.paid, { type: 'purchase', id: purchaseId }, no);
    if (input.poId) refreshPoStatus(ctx, input.poId);
    audit(ctx, 'purchase.create', 'purchase', purchaseId, undefined, { purchaseNo: no, total, paid: input.paid, supplierId: input.supplierId });
    return getPurchase(ctx, purchaseId);
  });
}

export function getPurchase(ctx: Ctx, id: number): any {
  requirePerm(ctx, 'purchases.view');
  const p = ctx.db.prepare(
    `SELECT pu.*, s.name AS supplier_name, s.phone AS supplier_phone, u.full_name AS user_name, l.name AS location_name, po.po_no
     FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id LEFT JOIN users u ON u.id = pu.user_id
     LEFT JOIN locations l ON l.id = pu.location_id LEFT JOIN purchase_orders po ON po.id = pu.po_id WHERE pu.id = ?`,
  ).get(id) as Record<string, any> | undefined;
  if (!p) throw new AppError('NOT_FOUND');
  const items = ctx.db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(id);
  const returns = ctx.db.prepare('SELECT id, return_no, total, refund_method, created_at FROM purchase_returns WHERE purchase_id = ?').all(id);
  return { ...p, items, returns };
}

export function listPurchases(ctx: Ctx, opts: { from: string; to: string; supplierId?: number | null; q?: string }) {
  requirePerm(ctx, 'purchases.view');
  const conds = ['pu.business_date BETWEEN @from AND @to'];
  const params: Record<string, unknown> = { from: opts.from, to: opts.to };
  if (opts.supplierId) { conds.push('pu.supplier_id = @sid'); params.sid = opts.supplierId; }
  if (opts.q?.trim()) { conds.push('(pu.purchase_no LIKE @q OR pu.supplier_invoice_no LIKE @q OR s.name LIKE @q)'); params.q = `%${opts.q.trim()}%`; }
  const rows = ctx.db.prepare(
    `SELECT pu.id, pu.purchase_no, pu.supplier_invoice_no, pu.purchase_date, pu.total, pu.paid, pu.total - pu.paid AS remaining, pu.created_at,
            s.name AS supplier_name, u.full_name AS user_name, (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS items_count
     FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id LEFT JOIN users u ON u.id = pu.user_id
     WHERE ${conds.join(' AND ')} ORDER BY pu.id DESC LIMIT 1000`,
  ).all(params);
  const sum = ctx.db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(pu.total),0) AS total, COALESCE(SUM(pu.paid),0) AS paid FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id WHERE ${conds.join(' AND ')}`,
  ).get(params);
  return { rows, sum };
}

/** Return goods to a supplier. Stock leaves at average cost; supplier balance or cash is credited with the agreed price. */
/**
 * Supplier return. Batch-aware: a line may name the exact batch (or the purchase line whose batch it was);
 * stock then leaves that batch only. Never returns more than the batch / purchase line holds and never
 * makes stock negative. Stock, batch, movement ledger, supplier balance (or drawer) and audit change
 * together in one transaction.
 */
export function createPurchaseReturn(ctx: Ctx, raw: PurchaseReturnInput) {
  requirePerm(ctx, 'purchases.manage');
  const input = purchaseReturnInput.parse(raw);
  return tx(ctx, () => {
    let supplierId = input.supplierId ?? null;
    let locationId = input.locationId ?? null;
    if (input.purchaseId) {
      const p = ctx.db.prepare('SELECT supplier_id, location_id FROM purchases WHERE id = ?').get(input.purchaseId) as { supplier_id: number | null; location_id: number } | undefined;
      if (!p) throw new AppError('NOT_FOUND');
      supplierId = p.supplier_id;
      locationId = p.location_id;
    }
    // resolve the batch of every line up front (explicit batch, or the batch created by the purchase line)
    const batchOf = (l: (typeof input.lines)[number]): BatchRow | null => {
      let id = l.batchId ?? null;
      if (!id && l.purchaseItemId) id = (ctx.db.prepare('SELECT batch_id FROM purchase_items WHERE id = ?').get(l.purchaseItemId) as { batch_id: number | null } | undefined)?.batch_id ?? null;
      if (!id) return null;
      const b = ctx.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as BatchRow | undefined;
      if (!b || b.product_id !== l.productId) throw new AppError('BATCH_NOT_FOUND');
      return b;
    };
    const batches = input.lines.map(batchOf);
    const firstBatch = batches.find(Boolean);
    if (!locationId) locationId = firstBatch?.location_id ?? defaultLocationId(ctx.db);
    for (const b of batches) {
      if (!b) continue;
      if (b.supplier_id && !supplierId) supplierId = b.supplier_id;
      if (b.supplier_id && supplierId && b.supplier_id !== supplierId) throw new AppError('BATCH_SUPPLIER_MISMATCH');
    }
    if (input.refundMethod === 'balance' && !supplierId) throw new AppError('VALIDATION', { detail: 'اختر المورد' });
    const no = docNo(ctx.db, 'purchase_return', 'PR-', 6);
    const info = ctx.db.prepare(
      `INSERT INTO purchase_returns(return_no, purchase_id, supplier_id, location_id, total, refund_method, reason, user_id, business_date, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(no, input.purchaseId ?? null, supplierId, locationId, input.refundMethod, input.reason ?? null, ctx.user?.id ?? null, today(ctx), ts(ctx));
    const retId = Number(info.lastInsertRowid);
    let total = 0;
    const ins = ctx.db.prepare(
      `INSERT INTO purchase_return_items(return_id, purchase_item_id, product_id, unit_id, qty, base_qty, unit_cost, total, cost_total, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const auditLines: unknown[] = [];
    input.lines.forEach((l, i) => {
      const u = unitInfo(ctx, l.productId, l.unitId);
      const base = toBaseQty(l.qty, u.factor);
      if (l.purchaseItemId) {
        const pi = ctx.db.prepare('SELECT base_qty, returned_base_qty, purchase_id FROM purchase_items WHERE id = ?').get(l.purchaseItemId) as { base_qty: number; returned_base_qty: number; purchase_id: number } | undefined;
        if (!pi || (input.purchaseId && pi.purchase_id !== input.purchaseId)) throw new AppError('NOT_FOUND');
        if (base > pi.base_qty - pi.returned_base_qty) throw new AppError('RETURN_QTY_EXCEEDED', { name: u.product_name });
        ctx.db.prepare('UPDATE purchase_items SET returned_base_qty = returned_base_qty + ? WHERE id = ?').run(base, l.purchaseItemId);
      }
      const b = batches[i];
      // a batch return without a stated price is credited at that batch's own purchase cost (users who
      // cannot see costs can still return goods correctly)
      const atBatchCost = !!b && !l.unitCost;
      const unitCost = atBatchCost ? Math.round((b!.unit_cost * u.factor) / 1000) : l.unitCost;
      const lineTotal = atBatchCost ? Math.round((b!.unit_cost * base) / 1000) : Math.round((unitCost * l.qty) / 1000);
      const move = { productId: l.productId, locationId: locationId!, qty: base, type: 'purchase_return' as const, refType: 'purchase_return', refId: retId, note: input.reason };
      // goods can only go back if we hold them: never below zero, whatever the negative-stock setting
      const out = b ? issueFromBatch(ctx, { ...move, batchId: b.id }) : issueStock(ctx, { ...move, allowNegative: false });
      ins.run(retId, l.purchaseItemId ?? null, l.productId, l.unitId, l.qty, base, unitCost, lineTotal, out.costTotal, b?.id ?? null);
      auditLines.push({ productId: l.productId, qty: base, batchId: b?.id ?? null, expiry: b?.expiry_date ?? null, total: lineTotal });
      total += lineTotal;
    });
    ctx.db.prepare('UPDATE purchase_returns SET total = ? WHERE id = ?').run(total, retId);
    if (input.refundMethod === 'balance') postLedger(ctx, 'supplier', supplierId!, 'return', -total, { type: 'purchase_return', id: retId }, `مرتجع شراء ${no}`);
    else {
      const s = shiftForCash(ctx);
      if (s) addCashMovement(ctx, s.id, 'deposit', total, { type: 'purchase_return', id: retId }, `مرتجع شراء ${no}`);
    }
    audit(ctx, 'purchase.return', 'purchase_return', retId, undefined, { returnNo: no, total, supplierId, refund: input.refundMethod, lines: auditLines }, input.reason ?? null);
    return { id: retId, returnNo: no, total };
  });
}

export function listPurchaseReturns(ctx: Ctx, opts: { from: string; to: string }) {
  requirePerm(ctx, 'purchases.view');
  return ctx.db.prepare(
    `SELECT r.*, s.name AS supplier_name, pu.purchase_no, u.full_name AS user_name FROM purchase_returns r LEFT JOIN suppliers s ON s.id = r.supplier_id
     LEFT JOIN purchases pu ON pu.id = r.purchase_id LEFT JOIN users u ON u.id = r.user_id WHERE r.business_date BETWEEN ? AND ? ORDER BY r.id DESC`,
  ).all(opts.from, opts.to);
}

/* ------------------------------------------------------------------ purchase orders (no stock effect) */

function refreshPoStatus(ctx: Ctx, poId: number) {
  const rows = ctx.db.prepare('SELECT qty, received_qty FROM purchase_order_items WHERE po_id = ?').all(poId) as { qty: number; received_qty: number }[];
  const any = rows.some((r) => r.received_qty > 0);
  const all = rows.every((r) => r.received_qty >= r.qty);
  const status = all ? 'received' : any ? 'partial' : 'open';
  ctx.db.prepare(`UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ? AND status <> 'cancelled'`).run(status, ts(ctx), poId);
}

export function savePurchaseOrder(ctx: Ctx, id: number | null, raw: PurchaseOrderInput) {
  requirePerm(ctx, 'purchase_orders.manage');
  const input = purchaseOrderInput.parse(raw);
  return tx(ctx, () => {
    const locationId = input.locationId ?? defaultLocationId(ctx.db);
    const total = input.lines.reduce((a, l) => a + Math.round((l.unitCost * l.qty) / 1000), 0);
    let poId = id;
    if (id) {
      const cur = ctx.db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as { status: string } | undefined;
      if (!cur) throw new AppError('NOT_FOUND');
      if (cur.status !== 'open') throw new AppError('PO_NOT_OPEN');
      ctx.db.prepare('UPDATE purchase_orders SET supplier_id = ?, location_id = ?, expected_date = ?, notes = ?, total = ?, updated_at = ? WHERE id = ?')
        .run(input.supplierId, locationId, input.expectedDate ?? null, input.notes ?? null, total, ts(ctx), id);
      ctx.db.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(id);
    } else {
      const no = docNo(ctx.db, 'po', 'PO-', 5);
      poId = Number(ctx.db.prepare(
        `INSERT INTO purchase_orders(po_no, supplier_id, location_id, expected_date, total, notes, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(no, input.supplierId, locationId, input.expectedDate ?? null, total, input.notes ?? null, ctx.user?.id ?? null, ts(ctx), ts(ctx)).lastInsertRowid);
    }
    const ins = ctx.db.prepare('INSERT INTO purchase_order_items(po_id, product_id, unit_id, factor, qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)');
    for (const l of input.lines) {
      const u = unitInfo(ctx, l.productId, l.unitId);
      ins.run(poId, l.productId, l.unitId, u.factor, l.qty, l.unitCost);
    }
    audit(ctx, id ? 'po.update' : 'po.create', 'purchase_order', poId, undefined, { total, supplierId: input.supplierId });
    return getPurchaseOrder(ctx, poId!);
  });
}

export function getPurchaseOrder(ctx: Ctx, id: number): any {
  requirePerm(ctx, 'purchases.view');
  const po = ctx.db.prepare(
    `SELECT po.*, s.name AS supplier_name, s.phone AS supplier_phone, u.full_name AS user_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN users u ON u.id = po.user_id WHERE po.id = ?`,
  ).get(id) as Record<string, any> | undefined;
  if (!po) throw new AppError('NOT_FOUND');
  const items = ctx.db.prepare(
    `SELECT i.*, p.name AS product_name, p.variant_name, un.name AS unit_name FROM purchase_order_items i JOIN products p ON p.id = i.product_id
     JOIN units un ON un.id = i.unit_id WHERE i.po_id = ? ORDER BY i.id`,
  ).all(id);
  const receipts = ctx.db.prepare('SELECT id, purchase_no, total, created_at FROM purchases WHERE po_id = ?').all(id);
  return { ...po, items, receipts };
}

export function listPurchaseOrders(ctx: Ctx, opts: { status?: string | null } = {}) {
  requirePerm(ctx, 'purchases.view');
  return ctx.db.prepare(
    `SELECT po.id, po.po_no, po.status, po.total, po.expected_date, po.created_at, s.name AS supplier_name,
            (SELECT COUNT(*) FROM purchase_order_items i WHERE i.po_id = po.id) AS items_count
     FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id ${opts.status ? 'WHERE po.status = @st' : ''} ORDER BY po.id DESC LIMIT 500`,
  ).all({ st: opts.status ?? null });
}

export function cancelPurchaseOrder(ctx: Ctx, id: number) {
  requirePerm(ctx, 'purchase_orders.manage');
  const r = ctx.db.prepare(`UPDATE purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('open','partial')`).run(ts(ctx), id);
  if (!r.changes) throw new AppError('PO_NOT_OPEN');
  audit(ctx, 'po.cancel', 'purchase_order', id);
  return { ok: true };
}

/** Build a purchase draft (lines with remaining quantities) from a PO for receiving. */
export function poReceiveDraft(ctx: Ctx, id: number) {
  const po: any = getPurchaseOrder(ctx, id);
  if (!['open', 'partial'].includes(po.status)) throw new AppError('PO_NOT_OPEN');
  const lines = (po.items as any[]).filter((i) => i.qty > i.received_qty).map((i) => ({
    productId: i.product_id, unitId: i.unit_id, qty: i.qty - i.received_qty, unitCost: i.unit_cost, discount: 0, poItemId: i.id,
    productName: i.variant_name ? `${i.product_name} ${i.variant_name}` : i.product_name, unitName: i.unit_name,
  }));
  return { poId: po.id, supplierId: po.supplier_id, locationId: po.location_id, lines };
}
