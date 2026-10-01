import { AppError } from '../../shared/errors';
import { formatQty } from '../../shared/qty';
import { normalizeArabic } from '../../shared/arabic';
import { adjustmentInput, transferInput, type AdjustmentInput } from '../../shared/schemas';
import {
  type Ctx, audit, can, defaultLocationId, docNo, getSetting, requirePerm, today, ts, tx,
} from './context';

export type MovementType =
  | 'opening' | 'purchase' | 'sale' | 'sale_return' | 'purchase_return' | 'stocktake'
  | 'damage' | 'loss' | 'adjustment' | 'transfer_in' | 'transfer_out' | 'void';

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  opening: 'رصيد افتتاحي',
  purchase: 'شراء',
  sale: 'بيع',
  sale_return: 'مرتجع بيع',
  purchase_return: 'مرتجع شراء',
  stocktake: 'جرد',
  damage: 'تلف',
  loss: 'فقد',
  adjustment: 'تسوية',
  transfer_in: 'تحويل وارد',
  transfer_out: 'تحويل صادر',
  void: 'إلغاء فاتورة',
};

interface ProductCostRow { id: number; name: string; avg_cost: number; track_expiry: number; active: number }

export function getStock(ctx: Ctx, productId: number, locationId: number): number {
  const row = ctx.db.prepare('SELECT qty FROM product_stock WHERE product_id = ? AND location_id = ?').get(productId, locationId) as { qty: number } | undefined;
  return row?.qty ?? 0;
}

export function totalStock(ctx: Ctx, productId: number): number {
  const row = ctx.db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM product_stock WHERE product_id = ?').get(productId) as { q: number };
  return row.q;
}

function loadProduct(ctx: Ctx, productId: number): ProductCostRow {
  const p = ctx.db.prepare('SELECT id, name, avg_cost, track_expiry, active FROM products WHERE id = ?').get(productId) as ProductCostRow | undefined;
  if (!p) throw new AppError('NOT_FOUND');
  return p;
}

export interface MovementArgs {
  productId: number;
  locationId: number;
  type: MovementType;
  qty: number; // signed base milli
  unitCost: number; // per base unit
  refType?: string | null;
  refId?: number | null;
  note?: string | null;
  allowNegative?: boolean;
}

/**
 * The single choke point for changing stock. Every quantity change writes a
 * ledger row with before/after values. Must be called inside a transaction.
 */
export function applyMovement(ctx: Ctx, m: MovementArgs): { before: number; after: number; movementId: number } {
  if (!Number.isInteger(m.qty) || m.qty === 0) throw new AppError('INVALID_QTY');
  const db = ctx.db;
  db.prepare('INSERT INTO product_stock(product_id, location_id, qty) VALUES (?, ?, 0) ON CONFLICT DO NOTHING').run(m.productId, m.locationId);
  const before = getStock(ctx, m.productId, m.locationId);
  const after = before + m.qty;
  if (m.qty < 0 && after < 0 && !m.allowNegative) {
    const p = loadProduct(ctx, m.productId);
    throw new AppError('INSUFFICIENT_STOCK', { name: p.name, available: formatQty(Math.max(before, 0)) });
  }
  db.prepare('UPDATE product_stock SET qty = ? WHERE product_id = ? AND location_id = ?').run(after, m.productId, m.locationId);
  const info = db.prepare(
    `INSERT INTO stock_movements(product_id, location_id, type, qty, qty_before, qty_after, unit_cost, ref_type, ref_id, note, user_id, business_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(m.productId, m.locationId, m.type, m.qty, before, after, m.unitCost, m.refType ?? null, m.refId ?? null, m.note ?? null, ctx.user?.id ?? null, today(ctx), ts(ctx));
  return { before, after, movementId: Number(info.lastInsertRowid) };
}

/**
 * Weighted Average Cost update for incoming stock.
 * new_avg = (on_hand * avg + in_qty * in_cost) / (on_hand + in_qty)
 * When on-hand is zero or negative, the incoming cost becomes the average.
 */
export function updateAverageCost(ctx: Ctx, productId: number, inQty: number, inUnitCost: number): number {
  const p = loadProduct(ctx, productId);
  const onHand = totalStock(ctx, productId);
  let avg: number;
  if (onHand <= 0) avg = inUnitCost;
  else avg = (onHand * p.avg_cost + inQty * inUnitCost) / (onHand + inQty);
  avg = Math.round(avg * 10000) / 10000;
  ctx.db.prepare('UPDATE products SET avg_cost = ? WHERE id = ?').run(avg, productId);
  return avg;
}

export interface BatchInfo {
  batchNo?: string | null; expiryDate?: string | null;
  /** lineage: who supplied the goods; for a transfer, the batch they came from and its original receipt time */
  supplierId?: number | null; sourceBatchId?: number | null; receivedAt?: string | null;
}

/** Receive stock: updates WAC (before increasing on-hand), creates batch if needed, writes movement. */
export function receiveStock(
  ctx: Ctx,
  args: { productId: number; locationId: number; qty: number; unitCost: number; type: MovementType; refType?: string; refId?: number; note?: string | null; batch?: BatchInfo | null; updateCost?: boolean },
): { batchId: number | null } {
  if (args.qty <= 0) throw new AppError('INVALID_QTY');
  const p = loadProduct(ctx, args.productId);
  if (args.updateCost !== false) updateAverageCost(ctx, args.productId, args.qty, args.unitCost);
  applyMovement(ctx, { ...args, qty: args.qty, allowNegative: true });
  let batchId: number | null = null;
  if (p.track_expiry && getSetting(ctx.db, 'features.expiry')) {
    if (!args.batch?.expiryDate && ['purchase', 'opening'].includes(args.type)) {
      throw new AppError('EXPIRY_REQUIRED', { name: p.name });
    }
    batchId = addToBatch(ctx, args.productId, args.locationId, args.qty, args.unitCost, args.batch ?? {}, args.refType, args.refId);
  }
  return { batchId };
}

/**
 * Every receipt is its own batch: quantity, cost, expiry, supplier and receipt time are kept per batch
 * and are never merged into an older batch, so a new delivery can never change an old one.
 */
export function addToBatch(ctx: Ctx, productId: number, locationId: number, qty: number, unitCost: number, b: BatchInfo, refType?: string, refId?: number): number {
  const info = ctx.db.prepare(
    `INSERT INTO batches(product_id, location_id, batch_no, expiry_date, qty, initial_qty, unit_cost, received_at, ref_type, ref_id, supplier_id, source_batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(productId, locationId, b.batchNo ?? null, b.expiryDate ?? null, qty, qty, unitCost, b.receivedAt ?? ts(ctx), refType ?? null, refId ?? null, b.supplierId ?? null, b.sourceBatchId ?? null);
  return Number(info.lastInsertRowid);
}

/**
 * What can legally be sold at a location: valid (not yet expired) batches plus any stock that predates
 * batch tracking. A batch is expired from the day after its expiry date.
 */
export function sellableStock(ctx: Ctx, productId: number, locationId: number): { onHand: number; sellable: number; expired: number } {
  const onHand = getStock(ctx, productId, locationId);
  const p = loadProduct(ctx, productId);
  if (!p.track_expiry) return { onHand, sellable: onHand, expired: 0 };
  const r = ctx.db.prepare(
    `SELECT COALESCE(SUM(qty),0) AS total, COALESCE(SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date < ? THEN qty ELSE 0 END),0) AS expired
     FROM batches WHERE product_id = ? AND location_id = ? AND qty > 0`,
  ).get(today(ctx), productId, locationId) as { total: number; expired: number };
  const unbatched = Math.max(0, onHand - r.total);
  return { onHand, sellable: Math.max(0, r.total - r.expired) + unbatched, expired: r.expired };
}

/**
 * First-Expiry-First-Out consumption of batch quantities. Returns allocations.
 * With `excludeExpired` (sales) batches past their expiry date are never touched.
 */
export function consumeBatches(ctx: Ctx, productId: number, locationId: number, qty: number, opts: { excludeExpired?: boolean } = {}): { batchId: number; qty: number }[] {
  const p = loadProduct(ctx, productId);
  if (!p.track_expiry) return [];
  const rows = ctx.db.prepare(
    `SELECT id, qty FROM batches WHERE product_id = @p AND location_id = @l AND qty > 0
       ${opts.excludeExpired ? 'AND (expiry_date IS NULL OR expiry_date >= @t)' : ''}
     ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date, id`,
  ).all({ p: productId, l: locationId, t: today(ctx) }) as { id: number; qty: number }[];
  let remaining = qty;
  const out: { batchId: number; qty: number }[] = [];
  const upd = ctx.db.prepare('UPDATE batches SET qty = qty - ? WHERE id = ?');
  for (const r of rows) {
    if (remaining <= 0) break;
    const take = Math.min(r.qty, remaining);
    upd.run(take, r.id);
    out.push({ batchId: r.id, qty: take });
    remaining -= take;
  }
  return out;
}

export function restoreBatches(ctx: Ctx, allocations: { batchId: number; qty: number }[]): void {
  const upd = ctx.db.prepare('UPDATE batches SET qty = qty + ? WHERE id = ?');
  for (const a of allocations) upd.run(a.qty, a.batchId);
}

/** Remove stock (sale, damage, etc.) at the current average cost. */
export function issueStock(
  ctx: Ctx,
  args: { productId: number; locationId: number; qty: number; type: MovementType; refType?: string; refId?: number; note?: string | null; allowNegative?: boolean; sellableOnly?: boolean },
): { unitCost: number; costTotal: number; batches: { batchId: number; qty: number }[] } {
  if (args.qty <= 0) throw new AppError('INVALID_QTY');
  const p = loadProduct(ctx, args.productId);
  if (args.sellableOnly && p.track_expiry) {
    // never sell expired goods — enforced here, whatever the UI or the negative-stock setting says
    const st = sellableStock(ctx, args.productId, args.locationId);
    if (st.expired > 0 && args.qty > st.sellable) {
      throw new AppError('EXPIRED_STOCK', { name: p.name, available: formatQty(st.sellable), expired: formatQty(st.expired) });
    }
  }
  const unitCost = p.avg_cost;
  applyMovement(ctx, { ...args, qty: -args.qty, unitCost });
  const batches = consumeBatches(ctx, args.productId, args.locationId, args.qty, { excludeExpired: args.sellableOnly });
  return { unitCost, costTotal: Math.round((unitCost * args.qty) / 1000), batches };
}

/**
 * Remove stock from one specific batch (supplier return of that batch). Refuses an unknown batch, a batch
 * of another product or location, more than the batch holds, and anything that would make stock negative.
 */
export function issueFromBatch(
  ctx: Ctx,
  args: { batchId: number; productId: number; locationId: number; qty: number; type: MovementType; refType?: string; refId?: number; note?: string | null },
): { unitCost: number; costTotal: number; batch: BatchRow } {
  if (!Number.isInteger(args.qty) || args.qty <= 0) throw new AppError('INVALID_QTY');
  const b = ctx.db.prepare('SELECT * FROM batches WHERE id = ?').get(args.batchId) as BatchRow | undefined;
  if (!b || b.product_id !== args.productId || b.location_id !== args.locationId) throw new AppError('BATCH_NOT_FOUND');
  const p = loadProduct(ctx, args.productId);
  if (args.qty > b.qty) throw new AppError('RETURN_EXCEEDS_BATCH', { name: p.name, available: formatQty(b.qty) });
  const unitCost = p.avg_cost;
  applyMovement(ctx, { ...args, qty: -args.qty, unitCost, allowNegative: false });
  ctx.db.prepare('UPDATE batches SET qty = qty - ? WHERE id = ? AND qty >= ?').run(args.qty, b.id, args.qty);
  return { unitCost, costTotal: Math.round((unitCost * args.qty) / 1000), batch: b };
}

export interface BatchRow {
  id: number; product_id: number; location_id: number; batch_no: string | null; expiry_date: string | null; qty: number; initial_qty: number;
  unit_cost: number; received_at: string; ref_type: string | null; ref_id: number | null; supplier_id: number | null; purchase_item_id: number | null; source_batch_id: number | null;
}

/* ------------------------------------------------------------------ documents */

export function createAdjustment(ctx: Ctx, raw: AdjustmentInput) {
  requirePerm(ctx, 'inventory.adjust');
  const input = adjustmentInput.parse(raw);
  const locationId = input.locationId ?? defaultLocationId(ctx.db);
  return tx(ctx, () => {
    const no = docNo(ctx.db, 'inventory_doc', 'INV-');
    const info = ctx.db.prepare(
      `INSERT INTO inventory_docs(doc_no, type, from_location_id, reason, user_id, business_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(no, input.type, locationId, input.reason ?? null, ctx.user?.id ?? null, today(ctx), ts(ctx));
    const docId = Number(info.lastInsertRowid);
    for (const l of input.lines) {
      const p = loadProduct(ctx, l.productId);
      if (input.type === 'opening' || (input.type === 'adjustment' && l.qty > 0)) {
        const cost = l.unitCost ?? p.avg_cost;
        receiveStock(ctx, {
          productId: l.productId, locationId, qty: Math.abs(l.qty), unitCost: cost, type: input.type,
          refType: 'inventory_doc', refId: docId, note: input.reason, batch: { expiryDate: l.expiryDate, batchNo: l.batchNo },
          updateCost: input.type === 'opening' || l.unitCost !== undefined,
        });
      } else {
        if (l.qty === 0) throw new AppError('INVALID_QTY');
        issueStock(ctx, {
          productId: l.productId, locationId, qty: Math.abs(l.qty), type: input.type,
          refType: 'inventory_doc', refId: docId, note: input.reason, allowNegative: true,
        });
      }
    }
    audit(ctx, `inventory.${input.type}`, 'inventory_doc', docId, undefined, { lines: input.lines, locationId }, input.reason);
    return { id: docId, docNo: no };
  });
}

export function createTransfer(ctx: Ctx, raw: unknown) {
  requirePerm(ctx, 'inventory.transfer');
  const input = transferInput.parse(raw);
  if (input.fromLocationId === input.toLocationId) throw new AppError('SAME_LOCATION');
  return tx(ctx, () => {
    const no = docNo(ctx.db, 'inventory_doc', 'INV-');
    const info = ctx.db.prepare(
      `INSERT INTO inventory_docs(doc_no, type, from_location_id, to_location_id, reason, user_id, business_date, created_at) VALUES (?, 'transfer', ?, ?, ?, ?, ?, ?)`,
    ).run(no, input.fromLocationId, input.toLocationId, input.reason ?? null, ctx.user?.id ?? null, today(ctx), ts(ctx));
    const docId = Number(info.lastInsertRowid);
    for (const l of input.lines) {
      const out = issueStock(ctx, { productId: l.productId, locationId: input.fromLocationId, qty: l.qty, type: 'transfer_out', refType: 'inventory_doc', refId: docId });
      applyMovement(ctx, { productId: l.productId, locationId: input.toLocationId, type: 'transfer_in', qty: l.qty, unitCost: out.unitCost, refType: 'inventory_doc', refId: docId, allowNegative: true });
      // move batch quantities along with the goods
      const toRow = ctx.db.prepare('SELECT batch_no, expiry_date, unit_cost, supplier_id, received_at FROM batches WHERE id = ?');
      for (const a of out.batches) {
        const b = toRow.get(a.batchId) as { batch_no: string | null; expiry_date: string | null; unit_cost: number; supplier_id: number | null; received_at: string };
        addToBatch(ctx, l.productId, input.toLocationId, a.qty, b.unit_cost,
          { batchNo: b.batch_no, expiryDate: b.expiry_date, supplierId: b.supplier_id, sourceBatchId: a.batchId, receivedAt: b.received_at }, 'inventory_doc', docId);
      }
    }
    audit(ctx, 'inventory.transfer', 'inventory_doc', docId, undefined, input);
    return { id: docId, docNo: no };
  });
}

/* ------------------------------------------------------------------ ledger & queries */

export function productLedger(ctx: Ctx, productId: number, opts: { limit?: number; offset?: number; locationId?: number | null } = {}) {
  requirePerm(ctx, 'inventory.view');
  const limit = Math.min(opts.limit ?? 100, 500);
  const where = opts.locationId ? 'AND m.location_id = @loc' : '';
  const cost = can(ctx, 'reports.cost') ? 'm.unit_cost' : 'NULL AS unit_cost';
  return ctx.db.prepare(
    `SELECT m.id, m.type, m.qty, m.qty_before, m.qty_after, ${cost}, m.ref_type, m.ref_id, m.note, m.created_at,
            u.full_name AS user_name, l.name AS location_name,
            CASE m.ref_type
              WHEN 'sale' THEN (SELECT invoice_no FROM sales WHERE id = m.ref_id)
              WHEN 'sale_return' THEN (SELECT return_no FROM sale_returns WHERE id = m.ref_id)
              WHEN 'purchase' THEN (SELECT purchase_no FROM purchases WHERE id = m.ref_id)
              WHEN 'purchase_return' THEN (SELECT return_no FROM purchase_returns WHERE id = m.ref_id)
              WHEN 'inventory_doc' THEN (SELECT doc_no FROM inventory_docs WHERE id = m.ref_id)
              WHEN 'stocktake' THEN (SELECT doc_no FROM stocktakes WHERE id = m.ref_id)
            END AS ref_no
     FROM stock_movements m
     LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN locations l ON l.id = m.location_id
     WHERE m.product_id = @pid ${where}
     ORDER BY m.id DESC LIMIT @limit OFFSET @offset`,
  ).all({ pid: productId, loc: opts.locationId ?? null, limit, offset: opts.offset ?? 0 });
}

export function movementsReport(ctx: Ctx, opts: { from: string; to: string; type?: string | null; productId?: number | null; limit?: number; offset?: number }) {
  requirePerm(ctx, 'inventory.view');
  const conds = ['m.business_date BETWEEN @from AND @to'];
  if (opts.type) conds.push('m.type = @type');
  if (opts.productId) conds.push('m.product_id = @pid');
  const params = { from: opts.from, to: opts.to, type: opts.type ?? null, pid: opts.productId ?? null, limit: Math.min(opts.limit ?? 200, 1000), offset: opts.offset ?? 0 };
  const showCost = can(ctx, 'reports.cost');
  const rows = ctx.db.prepare(
    `SELECT m.id, m.type, m.qty, m.qty_before, m.qty_after, ${showCost ? 'm.unit_cost' : 'NULL AS unit_cost'}, m.note, m.created_at, m.ref_type, m.ref_id,
            p.name AS product_name, un.symbol AS unit_symbol, u.full_name AS user_name, l.name AS location_name
     FROM stock_movements m
     JOIN products p ON p.id = m.product_id
     JOIN units un ON un.id = p.base_unit_id
     LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN locations l ON l.id = m.location_id
     WHERE ${conds.join(' AND ')}
     ORDER BY m.id DESC LIMIT @limit OFFSET @offset`,
  ).all(params);
  const totals = ctx.db.prepare(
    `SELECT m.type, COUNT(*) AS cnt, SUM(m.qty) AS qty, ${showCost ? 'SUM(ROUND(m.qty * m.unit_cost / 1000.0))' : 'NULL'} AS value
     FROM stock_movements m WHERE ${conds.join(' AND ')} GROUP BY m.type`,
  ).all(params);
  return { rows, totals };
}

export function listBatches(ctx: Ctx, productId: number) {
  requirePerm(ctx, 'inventory.view');
  const showCost = can(ctx, 'reports.cost');
  return (ctx.db.prepare(
    `SELECT b.*, l.name AS location_name FROM batches b JOIN locations l ON l.id = b.location_id
     WHERE b.product_id = ? ORDER BY (b.qty > 0) DESC, b.expiry_date`,
  ).all(productId) as Record<string, unknown>[]).map((b) => (showCost ? b : { ...b, unit_cost: null }));
}

export function listInventoryDocs(ctx: Ctx, opts: { limit?: number } = {}) {
  requirePerm(ctx, 'inventory.view');
  return ctx.db.prepare(
    `SELECT d.*, u.full_name AS user_name, lf.name AS from_location, lt.name AS to_location,
            (SELECT COUNT(*) FROM stock_movements m WHERE m.ref_type = 'inventory_doc' AND m.ref_id = d.id) AS lines,
            ${can(ctx, 'reports.cost') ? "(SELECT SUM(ROUND(m.qty * m.unit_cost / 1000.0)) FROM stock_movements m WHERE m.ref_type = 'inventory_doc' AND m.ref_id = d.id AND m.type NOT IN ('transfer_in'))" : 'NULL'} AS value
     FROM inventory_docs d LEFT JOIN users u ON u.id = d.user_id
     LEFT JOIN locations lf ON lf.id = d.from_location_id LEFT JOIN locations lt ON lt.id = d.to_location_id
     ORDER BY d.id DESC LIMIT ?`,
  ).all(Math.min(opts.limit ?? 200, 1000));
}

/* ------------------------------------------------------------------ stocktake */

export function startStocktake(ctx: Ctx, input: { locationId?: number | null; categoryId?: number | null; notes?: string | null }) {
  requirePerm(ctx, 'inventory.stocktake');
  const locationId = input.locationId ?? defaultLocationId(ctx.db);
  return tx(ctx, () => {
    const open = ctx.db.prepare(`SELECT id FROM stocktakes WHERE location_id = ? AND status = 'open'`).get(locationId);
    if (open) throw new AppError('STOCKTAKE_ALREADY_OPEN');
    const no = docNo(ctx.db, 'stocktake', 'JRD-', 5);
    const info = ctx.db.prepare(
      `INSERT INTO stocktakes(doc_no, location_id, status, scope, category_id, notes, created_by, created_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`,
    ).run(no, locationId, input.categoryId ? 'category' : 'all', input.categoryId ?? null, input.notes ?? null, ctx.user?.id ?? null, ts(ctx));
    const id = Number(info.lastInsertRowid);
    ctx.db.prepare(
      `INSERT INTO stocktake_items(stocktake_id, product_id, system_qty, counted_qty, unit_cost)
       SELECT ?, p.id, COALESCE(s.qty, 0), NULL, p.avg_cost FROM products p
       LEFT JOIN product_stock s ON s.product_id = p.id AND s.location_id = ?
       WHERE p.active = 1 ${input.categoryId ? 'AND p.category_id = ?' : ''}`,
    ).run(...([id, locationId, ...(input.categoryId ? [input.categoryId] : [])] as number[]));
    audit(ctx, 'stocktake.start', 'stocktake', id, undefined, { locationId, categoryId: input.categoryId });
    return { id, docNo: no };
  });
}

export function getStocktake(ctx: Ctx, id: number, opts: { q?: string; onlyDiff?: boolean; onlyUncounted?: boolean } = {}): any {
  requirePerm(ctx, 'inventory.stocktake');
  const st = ctx.db.prepare(
    `SELECT s.*, l.name AS location_name, u.full_name AS created_by_name FROM stocktakes s
     JOIN locations l ON l.id = s.location_id LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  if (!st) throw new AppError('NOT_FOUND');
  const conds = ['i.stocktake_id = @id'];
  if (opts.q) conds.push(`(p.search_text LIKE @q OR p.barcode = @raw OR p.sku = @raw)`);
  if (opts.onlyUncounted) conds.push('i.counted_qty IS NULL');
  const live = st.status === 'open';
  const sysExpr = live ? 'COALESCE((SELECT qty FROM product_stock ps WHERE ps.product_id = i.product_id AND ps.location_id = @loc), 0)' : 'i.system_qty';
  if (opts.onlyDiff) conds.push(`i.counted_qty IS NOT NULL AND i.counted_qty <> ${sysExpr}`);
  const items = ctx.db.prepare(
    `SELECT i.product_id, p.name, p.barcode, p.sku, un.symbol AS unit_symbol, un.allow_decimal, ${sysExpr} AS system_qty, i.counted_qty, i.unit_cost,
            c.name AS category_name
     FROM stocktake_items i JOIN products p ON p.id = i.product_id JOIN units un ON un.id = p.base_unit_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${conds.join(' AND ')} ORDER BY c.name, p.name LIMIT 2000`,
  ).all({ id, loc: st.location_id, q: `%${normalizeArabic(opts.q)}%`, raw: opts.q ?? '' });
  const stats = ctx.db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN counted_qty IS NOT NULL THEN 1 ELSE 0 END) AS counted,
            SUM(CASE WHEN counted_qty IS NOT NULL AND counted_qty <> ${sysExpr} THEN 1 ELSE 0 END) AS diffs,
            SUM(CASE WHEN counted_qty IS NOT NULL THEN ROUND((counted_qty - ${sysExpr}) * unit_cost / 1000.0) ELSE 0 END) AS diff_value
     FROM stocktake_items i WHERE i.stocktake_id = @id`,
  ).get({ id, loc: st.location_id });
  return { ...st, items, stats };
}

export function setStocktakeCount(ctx: Ctx, id: number, productId: number, countedQty: number | null) {
  requirePerm(ctx, 'inventory.stocktake');
  const st = ctx.db.prepare('SELECT status, location_id FROM stocktakes WHERE id = ?').get(id) as { status: string; location_id: number } | undefined;
  if (!st) throw new AppError('NOT_FOUND');
  if (st.status !== 'open') throw new AppError('STOCKTAKE_NOT_OPEN');
  if (countedQty !== null && (countedQty < 0 || !Number.isInteger(countedQty))) throw new AppError('INVALID_QTY');
  const res = ctx.db.prepare('UPDATE stocktake_items SET counted_qty = ? WHERE stocktake_id = ? AND product_id = ?').run(countedQty, id, productId);
  if (res.changes === 0) {
    // product created after the stocktake started
    ctx.db.prepare('INSERT INTO stocktake_items(stocktake_id, product_id, system_qty, counted_qty, unit_cost) SELECT ?, id, 0, ?, avg_cost FROM products WHERE id = ?').run(id, countedQty, productId);
  }
  return { ok: true };
}

/**
 * Completes the stocktake: for every counted item, the difference between the
 * counted quantity and the CURRENT system quantity becomes a 'stocktake'
 * movement. Uncounted items are left untouched (not assumed zero).
 */
export function completeStocktake(ctx: Ctx, id: number) {
  requirePerm(ctx, 'inventory.stocktake');
  return tx(ctx, () => {
    const st = ctx.db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id) as { id: number; status: string; location_id: number; doc_no: string } | undefined;
    if (!st) throw new AppError('NOT_FOUND');
    if (st.status !== 'open') throw new AppError('STOCKTAKE_NOT_OPEN');
    const items = ctx.db.prepare('SELECT product_id, counted_qty FROM stocktake_items WHERE stocktake_id = ? AND counted_qty IS NOT NULL').all(id) as { product_id: number; counted_qty: number }[];
    let adjusted = 0;
    let valueDiff = 0;
    const upd = ctx.db.prepare('UPDATE stocktake_items SET system_qty = ?, unit_cost = ? WHERE stocktake_id = ? AND product_id = ?');
    for (const it of items) {
      const current = getStock(ctx, it.product_id, st.location_id);
      const p = loadProduct(ctx, it.product_id);
      upd.run(current, p.avg_cost, id, it.product_id);
      const diff = it.counted_qty - current;
      if (diff === 0) continue;
      adjusted++;
      valueDiff += Math.round((diff * p.avg_cost) / 1000);
      if (diff > 0) {
        applyMovement(ctx, { productId: it.product_id, locationId: st.location_id, type: 'stocktake', qty: diff, unitCost: p.avg_cost, refType: 'stocktake', refId: id, allowNegative: true });
        if (p.track_expiry) addToBatch(ctx, it.product_id, st.location_id, diff, p.avg_cost, {}, 'stocktake', id);
      } else {
        applyMovement(ctx, { productId: it.product_id, locationId: st.location_id, type: 'stocktake', qty: diff, unitCost: p.avg_cost, refType: 'stocktake', refId: id, allowNegative: true });
        consumeBatches(ctx, it.product_id, st.location_id, -diff);
      }
    }
    ctx.db.prepare(`UPDATE stocktakes SET status = 'completed', completed_by = ?, completed_at = ? WHERE id = ?`).run(ctx.user?.id ?? null, ts(ctx), id);
    audit(ctx, 'stocktake.complete', 'stocktake', id, undefined, { adjusted, valueDiff });
    return { adjusted, valueDiff };
  });
}

export function cancelStocktake(ctx: Ctx, id: number) {
  requirePerm(ctx, 'inventory.stocktake');
  const r = ctx.db.prepare(`UPDATE stocktakes SET status = 'cancelled', completed_by = ?, completed_at = ? WHERE id = ? AND status = 'open'`).run(ctx.user?.id ?? null, ts(ctx), id);
  if (r.changes === 0) throw new AppError('STOCKTAKE_NOT_OPEN');
  audit(ctx, 'stocktake.cancel', 'stocktake', id);
  return { ok: true };
}

export function listStocktakes(ctx: Ctx) {
  requirePerm(ctx, 'inventory.stocktake');
  return ctx.db.prepare(
    `SELECT s.id, s.doc_no, s.status, s.created_at, s.completed_at, l.name AS location_name, c.name AS category_name, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM stocktake_items i WHERE i.stocktake_id = s.id) AS total_items,
            (SELECT COUNT(*) FROM stocktake_items i WHERE i.stocktake_id = s.id AND i.counted_qty IS NOT NULL) AS counted_items,
            (SELECT COUNT(*) FROM stocktake_items i WHERE i.stocktake_id = s.id AND i.counted_qty IS NOT NULL AND i.counted_qty <> i.system_qty) AS diff_items
     FROM stocktakes s JOIN locations l ON l.id = s.location_id LEFT JOIN categories c ON c.id = s.category_id
     LEFT JOIN users u ON u.id = s.created_by ORDER BY s.id DESC LIMIT 200`,
  ).all();
}

/* ------------------------------------------------------------------ locations */

export function listLocations(ctx: Ctx) {
  return ctx.db.prepare('SELECT * FROM locations ORDER BY is_default DESC, id').all();
}

export function saveLocation(ctx: Ctx, input: { id?: number; name: string; type: string; active?: boolean }) {
  requirePerm(ctx, 'settings.manage');
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError('VALIDATION', { detail: 'الاسم مطلوب' });
  const type = ['shop', 'warehouse', 'fridge', 'shelf', 'branch', 'other'].includes(input.type) ? input.type : 'other';
  try {
    if (input.id) {
      const cur = ctx.db.prepare('SELECT is_default FROM locations WHERE id = ?').get(input.id) as { is_default: number } | undefined;
      if (!cur) throw new AppError('NOT_FOUND');
      const active = cur.is_default ? 1 : input.active === false ? 0 : 1;
      ctx.db.prepare('UPDATE locations SET name = ?, type = ?, active = ? WHERE id = ?').run(name, type, active, input.id);
      return { id: input.id };
    }
    const info = ctx.db.prepare('INSERT INTO locations(store_id, name, type, is_default, created_at) VALUES (1, ?, ?, 0, ?)').run(name, type, ts(ctx));
    return { id: Number(info.lastInsertRowid) };
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new AppError('DUPLICATE_NAME', { name });
    throw e;
  }
}
