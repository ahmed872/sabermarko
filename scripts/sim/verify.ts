/**
 * INDEPENDENT VERIFIER for the one-year simulation.
 *
 * Deliberately imports NOTHING from the application: it opens the database
 * with plain SQL and recomputes inventory, money, balances and shifts from the
 * raw rows, then compares them with (a) what the application stored and
 * reported, and (b) the simulator's shadow model (what the simulated people
 * actually did). Any difference is a failure.
 *
 *   node dist/sim/verify.js --out sim-output
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const OUT = resolve(args[args.indexOf('--out') + 1] ?? 'sim-output');
const dbFile = args.includes('--db') ? args[args.indexOf('--db') + 1] : join(OUT, 'store.db');
const db = new Database(dbFile, { readonly: true, fileMustExist: true });
const sim = JSON.parse(readFileSync(join(OUT, 'sim-log.json'), 'utf8'));

type Check = { name: string; ok: boolean; checked: number; failures: number; sample?: unknown[]; note?: string };
const checks: Check[] = [];
function check(name: string, checked: number, bad: unknown[], note?: string) {
  checks.push({ name, ok: bad.length === 0, checked, failures: bad.length, sample: bad.slice(0, 5), note });
}
const all = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
const one = <T = any>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;

/* ================================================================== A. structure */
check('integrity_check', 1, (one<{ integrity_check: string }>('PRAGMA integrity_check').integrity_check === 'ok') ? [] : ['integrity_check failed']);
check('foreign_key_check', 1, all('PRAGMA foreign_key_check'));
const orphanQueries: Record<string, string> = {
  'sale_items without sale': 'SELECT id FROM sale_items WHERE sale_id NOT IN (SELECT id FROM sales)',
  'sale_payments without sale': 'SELECT id FROM sale_payments WHERE sale_id NOT IN (SELECT id FROM sales)',
  'return items without return': 'SELECT id FROM sale_return_items WHERE return_id NOT IN (SELECT id FROM sale_returns)',
  'purchase items without purchase': 'SELECT id FROM purchase_items WHERE purchase_id NOT IN (SELECT id FROM purchases)',
  'movements without product': 'SELECT id FROM stock_movements WHERE product_id NOT IN (SELECT id FROM products)',
  'cash movements without shift': 'SELECT id FROM cash_movements WHERE shift_id NOT IN (SELECT id FROM shifts)',
  'sales without items': `SELECT id FROM sales s WHERE NOT EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = s.id)`,
  'sale movements without a sale': `SELECT id FROM stock_movements WHERE ref_type = 'sale' AND ref_id NOT IN (SELECT id FROM sales)`,
  'ledger rows without customer': 'SELECT id FROM customer_ledger WHERE customer_id NOT IN (SELECT id FROM customers)',
};
for (const [n, q] of Object.entries(orphanQueries)) check(`orphans: ${n}`, 1, all(q));

/* ================================================================== B. inventory */
const stockRows = all<{ product_id: number; location_id: number; qty: number }>('SELECT product_id, location_id, qty FROM product_stock');
const mvSum = new Map(all<{ k: string; q: number }>(`SELECT product_id || '@' || location_id AS k, SUM(qty) AS q FROM stock_movements GROUP BY product_id, location_id`).map((r) => [r.k, r.q]));
check('stock = sum of ledger movements (every product x location)', stockRows.length,
  stockRows.filter((r) => (mvSum.get(`${r.product_id}@${r.location_id}`) ?? 0) !== r.qty).map((r) => ({ ...r, ledger: mvSum.get(`${r.product_id}@${r.location_id}`) })));
check('no negative stock', stockRows.length, stockRows.filter((r) => r.qty < 0));

// movement chain: qty_before = previous qty_after and qty_after = qty_before + qty
{
  const bad: unknown[] = []; let n = 0;
  const last = new Map<string, number>();
  for (const m of db.prepare('SELECT id, product_id, location_id, qty, qty_before, qty_after FROM stock_movements ORDER BY id').iterate() as Iterable<any>) {
    n++;
    const k = `${m.product_id}@${m.location_id}`;
    const prev = last.get(k) ?? 0;
    if (m.qty_before !== prev || m.qty_after !== m.qty_before + m.qty) bad.push({ id: m.id, k, prev, before: m.qty_before, after: m.qty_after, qty: m.qty });
    last.set(k, m.qty_after);
  }
  check('movement ledger chain is continuous (before/after)', n, bad);
}
// batches = stock for expiry-tracked products
{
  const rows = all(`SELECT ps.product_id, ps.location_id, ps.qty, COALESCE((SELECT SUM(b.qty) FROM batches b WHERE b.product_id = ps.product_id AND b.location_id = ps.location_id), 0) AS bq
                    FROM product_stock ps JOIN products p ON p.id = ps.product_id WHERE p.track_expiry = 1`);
  check('expiry batches sum = stock (tracked products)', rows.length, rows.filter((r) => r.bq !== r.qty));
  check('no negative batch quantity', 1, all('SELECT id, qty FROM batches WHERE qty < 0'));
}
// shadow model (what the simulated people did) vs database
{
  const shadow: Record<string, number> = sim.shadow.stock;
  const db_ = new Map(stockRows.map((r) => [`${r.product_id}@${r.location_id}`, r.qty]));
  const keys = new Set([...Object.keys(shadow), ...db_.keys()]);
  const bad = [...keys].filter((k) => (shadow[k] ?? 0) !== (db_.get(k) ?? 0)).map((k) => ({ k, shadow: shadow[k] ?? 0, db: db_.get(k) ?? 0 }));
  check('stock = independent shadow model (simulator)', keys.size, bad);
}
// document <-> movement linkage
{
  const bad = all(`SELECT si.sale_id, si.product_id, SUM(si.base_qty) AS sold,
      COALESCE((SELECT -SUM(m.qty) FROM stock_movements m WHERE m.ref_type = 'sale' AND m.ref_id = si.sale_id AND m.product_id = si.product_id AND m.type = 'sale'), 0) AS moved
    FROM sale_items si GROUP BY si.sale_id, si.product_id HAVING sold <> moved`);
  check('every sold quantity has its stock movement', one<{ n: number }>('SELECT COUNT(*) AS n FROM sale_items').n, bad);
  const voidBad = all(`SELECT s.id FROM sales s WHERE s.status = 'voided' AND
      (SELECT COALESCE(SUM(m.qty),0) FROM stock_movements m WHERE m.ref_type = 'sale' AND m.ref_id = s.id) <> 0`);
  check('voided invoices put all stock back (net movement 0)', one<{ n: number }>(`SELECT COUNT(*) AS n FROM sales WHERE status = 'voided'`).n, voidBad);
  const pBad = all(`SELECT pi.purchase_id, pi.product_id, SUM(pi.base_qty) AS bought,
      COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.ref_type = 'purchase' AND m.ref_id = pi.purchase_id AND m.product_id = pi.product_id), 0) AS moved
    FROM purchase_items pi GROUP BY pi.purchase_id, pi.product_id HAVING bought <> moved`);
  check('every purchased quantity has its stock movement', one<{ n: number }>('SELECT COUNT(*) AS n FROM purchase_items').n, pBad);
  const tBad = all(`SELECT ref_id, SUM(qty) AS net FROM stock_movements WHERE type IN ('transfer_in','transfer_out') GROUP BY ref_type, ref_id HAVING net <> 0`);
  check('transfers net to zero (nothing created or lost in transit)', one<{ n: number }>(`SELECT COUNT(DISTINCT ref_id) AS n FROM stock_movements WHERE type = 'transfer_in'`).n, tBad);
  const rBad = all(`SELECT ri.return_id, ri.product_id, SUM(ri.base_qty) AS back,
      COALESCE((SELECT SUM(m.qty) FROM stock_movements m WHERE m.ref_type = 'sale_return' AND m.ref_id = ri.return_id AND m.product_id = ri.product_id), 0) AS moved
    FROM sale_return_items ri WHERE ri.restock = 1 GROUP BY ri.return_id, ri.product_id HAVING back <> moved`);
  check('restocked returns have their stock movement', one<{ n: number }>('SELECT COUNT(*) AS n FROM sale_return_items WHERE restock = 1').n, rBad);
}
// monthly roll-forward: Opening + In - Out = Closing, and Closing = the snapshot taken that night
const monthly: any[] = [];
{
  const bad: unknown[] = [];
  for (const m of sim.months) {
    const opening = one<{ q: number }>('SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE business_date < ?', m.from).q;
    const io = one<{ i: number; o: number }>('SELECT COALESCE(SUM(CASE WHEN qty > 0 THEN qty END),0) AS i, COALESCE(SUM(CASE WHEN qty < 0 THEN -qty END),0) AS o FROM stock_movements WHERE business_date BETWEEN ? AND ?', m.from, m.to);
    const closingLedger = one<{ q: number }>('SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE business_date <= ?', m.to).q;
    const snapshot = Object.values(m.stockSnapshot as Record<string, number>).reduce((a, b) => a + b, 0);
    const byType = Object.fromEntries(all<{ type: string; q: number }>('SELECT type, SUM(qty) AS q FROM stock_movements WHERE business_date BETWEEN ? AND ? GROUP BY type', m.from, m.to).map((r) => [r.type, r.q]));
    // per-product snapshot comparison
    const perProduct = all<{ k: string; q: number }>(`SELECT product_id || '@' || location_id AS k, SUM(qty) AS q FROM stock_movements WHERE business_date <= ? GROUP BY product_id, location_id`, m.to);
    const snapDiffs = perProduct.filter((r) => (m.stockSnapshot[r.k] ?? 0) !== r.q).length;
    monthly.push({ month: m.label, opening, in: io.i, out: io.o, closing: closingLedger, snapshot, byType, snapDiffs });
    if (opening + io.i - io.o !== closingLedger || closingLedger !== snapshot || snapDiffs) bad.push({ month: m.label, opening, in: io.i, out: io.o, closingLedger, snapshot, snapDiffs });
  }
  check('monthly roll-forward Opening + In - Out = Closing = night snapshot', sim.months.length, bad);
}

// batches: expiry, lineage and batch-aware supplier returns
{
  const expiredSold = all(`SELECT si.id, b.expiry_date, s.business_date FROM sale_item_batches sib JOIN batches b ON b.id = sib.batch_id
      JOIN sale_items si ON si.id = sib.sale_item_id JOIN sales s ON s.id = si.sale_id WHERE b.expiry_date IS NOT NULL AND b.expiry_date < s.business_date`);
  check('no sale ever took goods from an expired batch', one<{ n: number }>('SELECT COUNT(*) AS n FROM sale_item_batches').n, expiredSold);
  const overReturned = all(`SELECT b.id, b.initial_qty, (SELECT SUM(ri.base_qty) FROM purchase_return_items ri WHERE ri.batch_id = b.id) AS returned
      FROM batches b WHERE (SELECT COALESCE(SUM(ri.base_qty),0) FROM purchase_return_items ri WHERE ri.batch_id = b.id) > b.initial_qty OR b.qty > b.initial_qty OR b.qty < 0`);
  check('supplier returns never exceed their batch; batch qty within 0..received', one<{ n: number }>('SELECT COUNT(*) AS n FROM batches').n, overReturned);
  const retMoves = all(`SELECT ri.return_id, ri.product_id, SUM(ri.base_qty) AS back,
      COALESCE((SELECT -SUM(m.qty) FROM stock_movements m WHERE m.ref_type = 'purchase_return' AND m.ref_id = ri.return_id AND m.product_id = ri.product_id), 0) AS moved
    FROM purchase_return_items ri GROUP BY ri.return_id, ri.product_id HAVING back <> moved`);
  check('every supplier return has its stock movement', one<{ n: number }>('SELECT COUNT(*) AS n FROM purchase_return_items').n, retMoves);
  const lineage = all(`SELECT b.id FROM batches b JOIN purchases p ON b.ref_type = 'purchase' AND p.id = b.ref_id
      WHERE COALESCE(b.supplier_id, -1) <> COALESCE(p.supplier_id, -1) OR b.purchase_item_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM purchase_items pi WHERE pi.id = b.purchase_item_id AND pi.batch_id = b.id AND pi.expiry_date IS b.expiry_date)`);
  check('every purchased batch carries its supplier, purchase line and expiry', one<{ n: number }>(`SELECT COUNT(*) AS n FROM batches WHERE ref_type = 'purchase'`).n, lineage);
}

/* ================================================================== C. money */
{
  const bad: unknown[] = []; let n = 0;
  const items = db.prepare(`SELECT sale_id, SUM(gross) AS gross, SUM(discount + promo_discount) AS ld, SUM(invoice_discount_share) AS share, SUM(total) AS total,
      SUM(net_revenue) AS net, SUM(cost_total) AS cost, SUM(tax) AS tax, COUNT(*) AS lines FROM sale_items GROUP BY sale_id`);
  const byId = new Map((items.all() as any[]).map((r) => [r.sale_id, r]));
  const pays = new Map((all(`SELECT sale_id, SUM(amount) AS a FROM sale_payments WHERE method <> 'credit' GROUP BY sale_id`) as any[]).map((r) => [r.sale_id, r.a]));
  for (const s of db.prepare('SELECT * FROM sales').iterate() as Iterable<any>) {
    n++;
    const it = byId.get(s.id);
    const paidNet = pays.get(s.id) ?? 0;
    const errs: string[] = [];
    if (!it) { bad.push({ id: s.id, err: 'no items' }); continue; }
    if (it.gross !== s.subtotal) errs.push('subtotal');
    if (it.ld !== s.line_discount) errs.push('line_discount');
    if (it.share !== s.invoice_discount) errs.push('invoice_discount');
    if (it.total + s.rounding !== s.total) errs.push('total');
    if (it.net !== s.net_revenue) errs.push('net_revenue');
    if (it.cost !== s.cogs) errs.push('cogs');
    if (it.lines !== s.items_count) errs.push('items_count');
    if (paidNet !== s.paid - s.change_due) errs.push('payments');
    if (paidNet + s.credit_amount !== s.total) errs.push('paid+credit!=total');
    if (errs.length) bad.push({ id: s.id, invoice: s.invoice_no, errs });
  }
  check('every invoice adds up (lines, discounts, payments, credit, COGS)', n, bad);
  const lineBad = all(`SELECT id, sale_id, gross, unit_price, qty, total, discount, promo_discount, invoice_discount_share, tax FROM sale_items
      WHERE gross <> CAST(ROUND(unit_price * qty / 1000.0) AS INTEGER) OR total <> gross - discount - promo_discount - invoice_discount_share + tax OR total < 0`);
  check('every invoice line adds up (price x qty - discounts)', one<{ n: number }>('SELECT COUNT(*) AS n FROM sale_items').n, lineBad);
  // COGS snapshot vs. the cost on the stock movement (independent path)
  const cogsBad = all(`SELECT si.id, si.cost_total, si.unit_cost, si.base_qty FROM sale_items si
      WHERE ABS(si.cost_total - ROUND(si.unit_cost * si.base_qty / 1000.0)) > 1`);
  check('line COGS = unit cost snapshot x quantity', one<{ n: number }>('SELECT COUNT(*) AS n FROM sale_items').n, cogsBad);
  const retBad = all(`SELECT r.id FROM sale_returns r JOIN (SELECT return_id, SUM(total) t, SUM(net_revenue) n, SUM(cost_total) c FROM sale_return_items GROUP BY return_id) x ON x.return_id = r.id
      WHERE x.t <> r.total OR x.n <> r.net_revenue OR x.c <> r.cogs`);
  check('every return adds up', one<{ n: number }>('SELECT COUNT(*) AS n FROM sale_returns').n, retBad);
  const overReturn = all(`SELECT id FROM sale_items WHERE returned_base_qty > base_qty`);
  check('nothing returned more than sold', 1, overReturn);
  const purBad = all(`SELECT p.id FROM purchases p JOIN (SELECT purchase_id, SUM(total) t FROM purchase_items GROUP BY purchase_id) x ON x.purchase_id = p.id
      WHERE p.subtotal <> x.t OR p.total <> p.subtotal - p.discount + p.tax`);
  check('every purchase invoice adds up', one<{ n: number }>('SELECT COUNT(*) AS n FROM purchases').n, purBad);
  const baseBad = all(`SELECT id FROM purchase_items WHERE base_qty <> CAST(ROUND(qty * factor / 1000.0) AS INTEGER)`);
  check('purchase unit conversions (carton -> pieces)', one<{ n: number }>('SELECT COUNT(*) AS n FROM purchase_items').n, baseBad);
}

// month-by-month P&L recomputed from raw rows vs. what the app reported that month
function pnl(from: string, to: string) {
  const s = one(`SELECT COUNT(*) AS invoices, COALESCE(SUM(total),0) AS total, COALESCE(SUM(net_revenue),0) AS net, COALESCE(SUM(cogs),0) AS cogs FROM sales WHERE status = 'completed' AND business_date BETWEEN ? AND ?`, from, to);
  const r = one(`SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(net_revenue),0) AS net, COALESCE(SUM(cogs),0) AS cogs FROM sale_returns WHERE business_date BETWEEN ? AND ?`, from, to);
  const e = one(`SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE deleted_at IS NULL AND business_date BETWEEN ? AND ?`, from, to);
  // COGS a second way: from the stock ledger (sale movements at their recorded cost), minus restocked returns
  const mv = one(`SELECT COALESCE(SUM(ROUND(-qty * unit_cost / 1000.0)),0) AS c FROM stock_movements m WHERE m.type = 'sale' AND m.business_date BETWEEN ? AND ?
                    AND EXISTS (SELECT 1 FROM sales s WHERE s.id = m.ref_id AND s.status = 'completed')`, from, to);
  const netRevenue = s.net - r.net; const cogs = s.cogs - r.cogs;
  return { invoices: s.invoices, netSales: s.total - r.total, netRevenue, cogs, grossProfit: netRevenue - cogs, expenses: e.t, netProfit: netRevenue - cogs - e.t, cogsFromLedger: mv.c - r.cogs };
}
const pnlMonths: any[] = [];
{
  const bad: unknown[] = [];
  for (const m of sim.months) {
    const x = pnl(m.from, m.to);
    pnlMonths.push({ month: m.label, ...x });
    const diffs = ['invoices', 'netSales', 'netRevenue', 'cogs', 'grossProfit', 'expenses', 'netProfit'].filter((k) => x[k as keyof typeof x] !== m[k]);
    if (diffs.length) bad.push({ month: m.label, diffs, app: Object.fromEntries(diffs.map((k) => [k, m[k]])), raw: Object.fromEntries(diffs.map((k) => [k, x[k as keyof typeof x]])) });
    // the ledger path may differ by rounding of fractional average costs only (<= 1 minor unit per line)
    const lines = one<{ n: number }>(`SELECT COUNT(*) AS n FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status = 'completed' AND s.business_date BETWEEN ? AND ?`, m.from, m.to).n;
    if (Math.abs(x.cogsFromLedger - x.cogs) > lines) bad.push({ month: m.label, cogs: x.cogs, cogsFromLedger: x.cogsFromLedger, lines });
  }
  check('monthly P&L recomputed from raw rows = app reports (and COGS = stock ledger)', sim.months.length, bad);
}

// customer & supplier balances: three ways (cached balance, ledger, documents) + shadow
{
  const bad: unknown[] = [];
  const cust = all(`SELECT c.id, c.balance,
      COALESCE((SELECT SUM(amount) FROM customer_ledger l WHERE l.customer_id = c.id), 0) AS ledger,
      COALESCE((SELECT SUM(credit_amount) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed'), 0)
      - COALESCE((SELECT SUM(total) FROM sale_returns r WHERE r.customer_id = c.id AND r.refund_method = 'credit'), 0)
      - COALESCE((SELECT SUM(amount) FROM party_payments p WHERE p.party_type = 'customer' AND p.party_id = c.id), 0)
      + COALESCE((SELECT SUM(amount) FROM customer_ledger l WHERE l.customer_id = c.id AND l.type IN ('opening','adjustment')), 0) AS docs
      FROM customers c`);
  for (const c of cust) {
    const shadow = sim.shadow.customers[c.id] ?? 0;
    if (c.balance !== c.ledger || c.ledger !== c.docs || c.balance !== shadow) bad.push({ ...c, shadow });
  }
  check('customer balances: cached = ledger = documents = shadow', cust.length, bad);
  const chain = all(`SELECT l.id FROM customer_ledger l WHERE l.balance_after <> (SELECT SUM(amount) FROM customer_ledger x WHERE x.customer_id = l.customer_id AND x.id <= l.id)`);
  check('customer ledger running balance', one<{ n: number }>('SELECT COUNT(*) AS n FROM customer_ledger').n, chain);
  const sbad: unknown[] = [];
  const sup = all(`SELECT s.id, s.balance,
      COALESCE((SELECT SUM(amount) FROM supplier_ledger l WHERE l.supplier_id = s.id), 0) AS ledger,
      COALESCE((SELECT SUM(total) FROM purchases p WHERE p.supplier_id = s.id), 0)
      - COALESCE((SELECT SUM(paid) FROM purchases p WHERE p.supplier_id = s.id), 0)
      - COALESCE((SELECT SUM(amount) FROM party_payments p WHERE p.party_type = 'supplier' AND p.party_id = s.id), 0)
      - COALESCE((SELECT SUM(total) FROM purchase_returns r WHERE r.supplier_id = s.id AND r.refund_method = 'balance'), 0)
      + COALESCE((SELECT SUM(amount) FROM supplier_ledger l WHERE l.supplier_id = s.id AND l.type IN ('opening','adjustment')), 0) AS docs
      FROM suppliers s`);
  for (const s of sup) {
    const shadow = sim.shadow.suppliers[s.id] ?? 0;
    if (s.balance !== s.ledger || s.ledger !== s.docs || s.balance !== shadow) sbad.push({ ...s, shadow });
  }
  check('supplier balances: cached = ledger = documents = shadow', sup.length, sbad);
}

// cash drawers
{
  const bad: unknown[] = [];
  const rows = all(`SELECT s.id, s.opening_cash, s.expected_cash, s.counted_cash, s.variance, COALESCE((SELECT SUM(amount) FROM cash_movements m WHERE m.shift_id = s.id), 0) AS moves FROM shifts s WHERE s.status = 'closed'`);
  const plan = new Map<number, any>(sim.shifts.map((x: any) => [x.id, x]));
  for (const r of rows) {
    const p = plan.get(r.id);
    const errs: string[] = [];
    if (r.expected_cash !== r.opening_cash + r.moves) errs.push('expected != opening + movements');
    if (r.variance !== r.counted_cash - r.expected_cash) errs.push('variance != counted - expected');
    if (!p) errs.push('not in simulation log');
    else { if (p.expectedShadow !== r.expected_cash) errs.push(`shadow drawer ${p.expectedShadow} != ${r.expected_cash}`); if (p.plannedVariance !== r.variance) errs.push(`planned variance ${p.plannedVariance} != ${r.variance}`); }
    if (errs.length) bad.push({ id: r.id, errs });
  }
  check('every shift: expected cash = opening + movements; variance = counted - expected = planned', rows.length, bad);
  // drawer movements re-derived from documents
  const docs = all(`SELECT s.id,
      COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp JOIN sales x ON x.id = sp.sale_id WHERE x.shift_id = s.id AND sp.method = 'cash'), 0) AS sales_cash,
      COALESCE((SELECT SUM(amount) FROM cash_movements m WHERE m.shift_id = s.id AND m.type = 'sale'), 0) AS mv_sale,
      COALESCE((SELECT SUM(total) FROM sale_returns r WHERE r.shift_id = s.id AND r.refund_method = 'cash'), 0) AS ret_cash,
      COALESCE((SELECT -SUM(amount) FROM cash_movements m WHERE m.shift_id = s.id AND m.type = 'refund'), 0) AS mv_ret,
      COALESCE((SELECT SUM(amount) FROM party_payments p WHERE p.shift_id = s.id AND p.party_type = 'customer' AND p.method = 'cash'), 0) AS coll,
      COALESCE((SELECT SUM(amount) FROM cash_movements m WHERE m.shift_id = s.id AND m.type = 'customer_payment'), 0) AS mv_coll,
      COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.shift_id = s.id AND e.paid_from_drawer = 1 AND e.deleted_at IS NULL), 0) AS exp,
      COALESCE((SELECT -SUM(amount) FROM cash_movements m WHERE m.shift_id = s.id AND m.type = 'expense'), 0) AS mv_exp
    FROM shifts s`);
  // sales_cash counts voided invoices too; the void is a separate negative movement
  const vbad = docs.filter((d) => d.mv_ret !== d.ret_cash || d.mv_coll !== d.coll || d.mv_exp !== d.exp || d.mv_sale !== d.sales_cash);
  check('drawer movements = cash on documents (sales, refunds, collections, expenses)', docs.length, vbad);
}

// daily closings: frozen numbers still match the raw data (nothing changed after closing)
{
  const bad: unknown[] = [];
  const rows = all('SELECT business_date, summary, closed_at FROM day_closings');
  for (const r of rows) {
    const s = JSON.parse(r.summary).summary;
    const x = pnl(r.business_date, r.business_date);
    if (s.netSales !== x.netSales || s.invoices !== x.invoices || s.netRevenue !== x.netRevenue) bad.push({ date: r.business_date, closed: { netSales: s.netSales, invoices: s.invoices }, now: { netSales: x.netSales, invoices: x.invoices } });
  }
  const late = all(`SELECT s.id, s.business_date FROM sales s JOIN day_closings d ON d.business_date = s.business_date WHERE s.created_at > d.closed_at`);
  check('daily closings still match the raw data', rows.length, bad);
  check('no invoice was added to a day after it was closed', rows.length, late);
}

// audit trail completeness for sensitive actions
{
  const voids = one<{ n: number }>(`SELECT COUNT(*) AS n FROM sales WHERE status = 'voided'`).n;
  const auditVoids = one<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sale.void'`).n;
  // a cashier needs a supervisor's approval; a manager/owner holds the permission and acts on their own
  const unapproved = all(`SELECT a.id FROM audit_log a JOIN users u ON u.id = a.user_id JOIN roles r ON r.id = u.role_id
                          WHERE a.action = 'sale.void' AND a.approved_by IS NULL AND r.code NOT IN ('admin','manager')`);
  check('every void is in the audit log (with an approver when done by a cashier)', voids, voids === auditVoids ? unapproved : [{ voids, auditVoids }]);
  const credit = one<{ n: number }>(`SELECT COUNT(*) AS n FROM sales s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id WHERE s.credit_amount > 0 AND r.code = 'cashier' AND s.approved_by IS NULL`).n;
  check('cashier credit sales always carry a manager approval', 1, credit ? [{ unapproved: credit }] : []);
}

/* ================================================================== D. the owner's year-end questions (raw SQL) */
const from = sim.months[0].from; const to = sim.months.at(-1).to;
const year = pnl(from, to);
const q = {
  year,
  topByRevenue: all(`SELECT p.name, SUM(si.net_revenue) AS revenue, SUM(si.base_qty) AS qty FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id WHERE s.status = 'completed' GROUP BY si.product_id ORDER BY revenue DESC LIMIT 10`),
  topByProfit: all(`SELECT p.name, SUM(si.net_revenue - si.cost_total) AS profit FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id WHERE s.status = 'completed' GROUP BY si.product_id ORDER BY profit DESC LIMIT 10`),
  categories: all(`SELECT COALESCE(c.name,'بدون') AS name, SUM(si.net_revenue) AS revenue, SUM(si.net_revenue - si.cost_total) AS profit FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id LEFT JOIN categories c ON c.id = p.category_id WHERE s.status = 'completed' GROUP BY c.id ORDER BY revenue DESC`),
  paymentMix: all(`SELECT method, SUM(amount) AS amount, COUNT(DISTINCT sale_id) AS invoices FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE s.status = 'completed' GROUP BY method`),
  creditSales: one(`SELECT COUNT(*) AS n, SUM(credit_amount) AS amount FROM sales WHERE status = 'completed' AND credit_amount > 0`),
  weekdays: all(`SELECT strftime('%w', business_date) AS dow, COUNT(*) AS invoices, SUM(total) AS total FROM sales WHERE status = 'completed' GROUP BY dow ORDER BY dow`),
  hours: all(`SELECT substr(created_at, 12, 2) AS hour, COUNT(*) AS invoices FROM sales WHERE status = 'completed' GROUP BY hour ORDER BY invoices DESC LIMIT 3`),
  deadAtYearEnd: one(`SELECT COUNT(*) AS n, COALESCE(SUM(ROUND(ps.qty * p.avg_cost / 1000.0)),0) AS value FROM products p JOIN (SELECT product_id, SUM(qty) qty FROM product_stock GROUP BY product_id) ps ON ps.product_id = p.id
      WHERE ps.qty > 0 AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.product_id = p.id AND s.status = 'completed' AND s.business_date > date(?, '-60 days'))`, to),
  expiredDisposed: one(`SELECT COUNT(*) AS events, COALESCE(SUM(ROUND(-qty * unit_cost / 1000.0)),0) AS value FROM stock_movements WHERE type = 'damage' AND note LIKE '%الصلاحية%'`),
  shrinkage: all(`SELECT type, COUNT(*) AS events, COALESCE(SUM(ROUND(-qty * unit_cost / 1000.0)),0) AS value FROM stock_movements WHERE type IN ('damage','loss','stocktake','adjustment') GROUP BY type`),
  inventoryValue: one(`SELECT COALESCE(SUM(ROUND(ps.qty * p.avg_cost / 1000.0)),0) AS cost, COALESCE(SUM(ROUND(ps.qty * p.sell_price / 1000.0)),0) AS retail FROM product_stock ps JOIN products p ON p.id = ps.product_id WHERE ps.qty > 0`),
  suppliersSpend: all(`SELECT s.name, SUM(p.total) AS spend, s.balance FROM purchases p JOIN suppliers s ON s.id = p.supplier_id GROUP BY s.id ORDER BY spend DESC LIMIT 5`),
  debts: one(`SELECT (SELECT COALESCE(SUM(balance),0) FROM customers) AS customersOwe, (SELECT COALESCE(SUM(balance),0) FROM suppliers) AS weOwe`),
  cashiers: all(`SELECT u.full_name AS name, COUNT(*) AS shifts, SUM(CASE WHEN s.variance < 0 THEN 1 ELSE 0 END) AS short, SUM(s.variance) AS variance FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.status = 'closed' GROUP BY u.id ORDER BY shifts DESC`),
  priceIncreases: one(`SELECT COUNT(*) AS n FROM price_history WHERE kind = 'sell'`),
  promotions: all(`SELECT name, type, start_date, end_date, suggestion_id IS NOT NULL AS fromSuggestion FROM promotions ORDER BY id`),
};

const failed = checks.filter((c) => !c.ok);
const report = { generatedFrom: dbFile, ok: failed.length === 0, checks, monthly, pnlMonths, questions: q, totals: {
  invoices: one<{ n: number }>('SELECT COUNT(*) AS n FROM sales').n,
  saleLines: one<{ n: number }>('SELECT COUNT(*) AS n FROM sale_items').n,
  movements: one<{ n: number }>('SELECT COUNT(*) AS n FROM stock_movements').n,
  products: one<{ n: number }>('SELECT COUNT(*) AS n FROM products').n,
  auditRows: one<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log').n,
} };
writeFileSync(join(OUT, args.includes('--report') ? args[args.indexOf('--report') + 1] : 'verify-report.json'), JSON.stringify(report, null, 1));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.checked})${c.ok ? '' : ` — ${c.failures} failures: ${JSON.stringify(c.sample).slice(0, 400)}`}`);
console.log(failed.length ? `\n${failed.length} CHECKS FAILED` : `\nALL ${checks.length} CHECKS PASSED`);
db.close();
process.exit(failed.length ? 1 : 0);
