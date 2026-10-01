import { AppError } from '../../shared/errors';
import { type Ctx, addDays, audit, can, getSetting, requirePerm, today, ts, tx } from './context';
import { openShifts } from './shifts';
import { formatQty } from '../../shared/qty';

/**
 * SINGLE SOURCE OF TRUTH for financial figures. Dashboard, daily closing,
 * cashier reports and profit reports all call `financialSummary`.
 *
 * Revenue recognition:
 *   net sales revenue = Σ sales.net_revenue (completed) − Σ returns.net_revenue (by return date)
 *   COGS              = Σ sales.cogs − Σ returns.cogs
 *   gross profit      = net revenue − COGS
 *   net profit        = gross profit − expenses
 */
export function financialSummary(ctx: Ctx, from: string, to: string, opts: { userId?: number | null } = {}) {
  const u = opts.userId ? 'AND user_id = @uid' : '';
  const p = { from, to, uid: opts.userId ?? null };
  const s = ctx.db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(subtotal),0) AS gross, COALESCE(SUM(line_discount),0) AS line_discount,
            COALESCE(SUM(invoice_discount),0) AS invoice_discount, COALESCE(SUM(tax_total),0) AS tax, COALESCE(SUM(total),0) AS total,
            COALESCE(SUM(net_revenue),0) AS net_revenue, COALESCE(SUM(cogs),0) AS cogs, COALESCE(SUM(items_count),0) AS lines,
            COALESCE(SUM(credit_amount),0) AS credit
     FROM sales WHERE status = 'completed' AND business_date BETWEEN @from AND @to ${u}`,
  ).get(p) as Record<string, number>;
  const r = ctx.db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(net_revenue),0) AS net_revenue, COALESCE(SUM(tax_total),0) AS tax,
            COALESCE(SUM(cogs),0) AS cogs FROM sale_returns WHERE business_date BETWEEN @from AND @to ${u}`,
  ).get(p) as Record<string, number>;
  const v = ctx.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM sales WHERE status = 'voided' AND business_date BETWEEN @from AND @to ${u}`).get(p) as Record<string, number>;
  const e = ctx.db.prepare(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM expenses WHERE deleted_at IS NULL AND business_date BETWEEN @from AND @to ${u}`).get(p) as Record<string, number>;
  const pay = ctx.db.prepare(
    `SELECT sp.method, COALESCE(SUM(sp.amount),0) AS amount FROM sale_payments sp JOIN sales sa ON sa.id = sp.sale_id
     WHERE sa.status = 'completed' AND sa.business_date BETWEEN @from AND @to ${opts.userId ? 'AND sa.user_id = @uid' : ''} GROUP BY sp.method`,
  ).all(p) as { method: string; amount: number }[];
  const refunds = ctx.db.prepare(`SELECT refund_method AS method, COALESCE(SUM(total),0) AS amount FROM sale_returns WHERE business_date BETWEEN @from AND @to ${u} GROUP BY refund_method`).all(p) as { method: string; amount: number }[];
  const qty = ctx.db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN un.allow_decimal = 1 THEN 1000 ELSE si.qty END),0) AS units FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
     JOIN units un ON un.id = si.unit_id WHERE sa.status = 'completed' AND sa.business_date BETWEEN @from AND @to ${opts.userId ? 'AND sa.user_id = @uid' : ''}`,
  ).get(p) as { units: number };
  const netRevenue = s.net_revenue - r.net_revenue;
  const cogs = s.cogs - r.cogs;
  const grossProfit = netRevenue - cogs;
  const netSales = s.total - r.total;
  const byMethod = Object.fromEntries(['cash', 'card', 'wallet', 'credit'].map((m) => [m, pay.find((x) => x.method === m)?.amount ?? 0]));
  const refundByMethod = Object.fromEntries(['cash', 'card', 'wallet', 'credit'].map((m) => [m, refunds.find((x) => x.method === m)?.amount ?? 0]));
  const showCost = can(ctx, 'reports.cost');
  return {
    from, to,
    invoices: s.count,
    grossSales: s.gross,
    discounts: s.line_discount + s.invoice_discount,
    lineDiscounts: s.line_discount,
    invoiceDiscounts: s.invoice_discount,
    salesTotal: s.total,
    tax: s.tax - r.tax,
    returns: { count: r.count, total: r.total },
    voids: { count: v.count, total: v.total },
    netSales,
    netRevenue,
    cogs: showCost ? cogs : null,
    grossProfit: showCost ? grossProfit : null,
    grossMarginPct: showCost && netRevenue > 0 ? Math.round((grossProfit / netRevenue) * 10000) / 100 : null,
    expenses: e.total,
    netProfit: showCost ? grossProfit - e.total : null,
    payments: byMethod,
    refunds: refundByMethod,
    creditSales: s.credit,
    avgBasket: s.count ? Math.round(s.total / s.count) : 0,
    avgItems: s.count ? Math.round((qty.units / 1000 / s.count) * 10) / 10 : 0,
    avgLines: s.count ? Math.round((s.lines / s.count) * 10) / 10 : 0,
  };
}

export function summaryReport(ctx: Ctx, from: string, to: string, userId?: number | null) {
  requirePerm(ctx, 'reports.view');
  return financialSummary(ctx, from, to, { userId });
}

/** Daily trend for charts — computed with the same formulas as financialSummary. */
export function dailyTrend(ctx: Ctx, from: string, to: string) {
  requirePerm(ctx, 'reports.view');
  const sales = ctx.db.prepare(
    `SELECT business_date AS d, COUNT(*) AS invoices, SUM(total) AS total, SUM(net_revenue) AS net, SUM(cogs) AS cogs FROM sales
     WHERE status = 'completed' AND business_date BETWEEN ? AND ? GROUP BY business_date`,
  ).all(from, to) as { d: string; invoices: number; total: number; net: number; cogs: number }[];
  const rets = ctx.db.prepare(`SELECT business_date AS d, SUM(total) AS total, SUM(net_revenue) AS net, SUM(cogs) AS cogs FROM sale_returns WHERE business_date BETWEEN ? AND ? GROUP BY business_date`).all(from, to) as { d: string; total: number; net: number; cogs: number }[];
  const exps = ctx.db.prepare(`SELECT business_date AS d, SUM(amount) AS total FROM expenses WHERE deleted_at IS NULL AND business_date BETWEEN ? AND ? GROUP BY business_date`).all(from, to) as { d: string; total: number }[];
  const showCost = can(ctx, 'reports.cost');
  const out: { date: string; sales: number; invoices: number; grossProfit: number | null; netProfit: number | null; expenses: number }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const s = sales.find((x) => x.d === d);
    const r = rets.find((x) => x.d === d);
    const e = exps.find((x) => x.d === d);
    const gp = (s?.net ?? 0) - (r?.net ?? 0) - ((s?.cogs ?? 0) - (r?.cogs ?? 0));
    out.push({ date: d, sales: (s?.total ?? 0) - (r?.total ?? 0), invoices: s?.invoices ?? 0, grossProfit: showCost ? gp : null, netProfit: showCost ? gp - (e?.total ?? 0) : null, expenses: e?.total ?? 0 });
    if (out.length > 400) break;
  }
  return out;
}

/** Product performance: separates best-selling (qty), top revenue and most profitable. */
export function productPerformance(ctx: Ctx, from: string, to: string, opts: { sort?: 'qty' | 'revenue' | 'profit' | 'count' | 'margin'; limit?: number; categoryId?: number | null } = {}) {
  requirePerm(ctx, 'reports.view');
  const showCost = can(ctx, 'reports.cost');
  const sort = opts.sort === 'profit' || opts.sort === 'margin' ? (showCost ? opts.sort : 'revenue') : opts.sort ?? 'qty';
  const order = { qty: 'qty DESC', revenue: 'revenue DESC', profit: 'profit DESC', count: 'times DESC', margin: 'margin DESC' }[sort];
  const rows = ctx.db.prepare(
    `WITH s AS (
       SELECT si.product_id, SUM(si.base_qty) AS qty, SUM(si.net_revenue) AS revenue, SUM(si.cost_total) AS cost, COUNT(DISTINCT si.sale_id) AS times
       FROM sale_items si JOIN sales sa ON sa.id = si.sale_id WHERE sa.status = 'completed' AND sa.business_date BETWEEN @from AND @to GROUP BY si.product_id),
     r AS (
       SELECT ri.product_id, SUM(ri.base_qty) AS qty, SUM(ri.net_revenue) AS revenue, SUM(ri.cost_total) AS cost
       FROM sale_return_items ri JOIN sale_returns rt ON rt.id = ri.return_id WHERE rt.business_date BETWEEN @from AND @to GROUP BY ri.product_id)
     SELECT p.id, p.name, p.variant_name, c.name AS category_name, u.symbol AS unit_symbol,
            COALESCE(s.qty,0) - COALESCE(r.qty,0) AS qty, COALESCE(s.revenue,0) - COALESCE(r.revenue,0) AS revenue,
            COALESCE(s.cost,0) - COALESCE(r.cost,0) AS cost, COALESCE(s.times,0) AS times,
            (COALESCE(s.revenue,0) - COALESCE(r.revenue,0)) - (COALESCE(s.cost,0) - COALESCE(r.cost,0)) AS profit,
            CASE WHEN COALESCE(s.revenue,0) - COALESCE(r.revenue,0) > 0 THEN ROUND(100.0 * ((COALESCE(s.revenue,0) - COALESCE(r.revenue,0)) - (COALESCE(s.cost,0) - COALESCE(r.cost,0))) / (COALESCE(s.revenue,0) - COALESCE(r.revenue,0)), 1) END AS margin,
            (SELECT COALESCE(SUM(qty),0) FROM product_stock ps WHERE ps.product_id = p.id) AS stock
     FROM s LEFT JOIN r ON r.product_id = s.product_id JOIN products p ON p.id = s.product_id JOIN units u ON u.id = p.base_unit_id
     LEFT JOIN categories c ON c.id = p.category_id ${opts.categoryId ? 'WHERE p.category_id = @cat' : ''}
     ORDER BY ${order} LIMIT ${Math.min(opts.limit ?? 50, 500)}`,
  ).all({ from, to, cat: opts.categoryId ?? null }) as Record<string, any>[];
  if (!showCost) for (const r of rows) { r.cost = null; r.profit = null; r.margin = null; }
  return rows;
}

export function categoryPerformance(ctx: Ctx, from: string, to: string) {
  requirePerm(ctx, 'reports.view');
  const showCost = can(ctx, 'reports.cost');
  const rows = ctx.db.prepare(
    `WITH x AS (
       SELECT si.product_id, si.net_revenue AS revenue, si.cost_total AS cost, si.sale_id FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
       WHERE sa.status = 'completed' AND sa.business_date BETWEEN @from AND @to
       UNION ALL
       SELECT ri.product_id, -ri.net_revenue, -ri.cost_total, NULL FROM sale_return_items ri JOIN sale_returns rt ON rt.id = ri.return_id
       WHERE rt.business_date BETWEEN @from AND @to)
     SELECT COALESCE(c.name, 'بدون تصنيف') AS name, c.id, SUM(x.revenue) AS revenue, SUM(x.cost) AS cost, SUM(x.revenue) - SUM(x.cost) AS profit,
            COUNT(DISTINCT x.sale_id) AS invoices
     FROM x JOIN products p ON p.id = x.product_id LEFT JOIN categories c ON c.id = p.category_id GROUP BY c.id ORDER BY revenue DESC`,
  ).all({ from, to }) as Record<string, any>[];
  if (!showCost) for (const r of rows) { r.cost = null; r.profit = null; }
  return rows;
}

export function cashierPerformance(ctx: Ctx, from: string, to: string) {
  requirePerm(ctx, 'reports.view');
  const users = ctx.db.prepare(
    `SELECT DISTINCT u.id, u.full_name FROM users u WHERE u.id IN (SELECT user_id FROM sales WHERE business_date BETWEEN @from AND @to
       UNION SELECT user_id FROM shifts WHERE substr(opened_at,1,10) BETWEEN @from AND @to UNION SELECT user_id FROM sale_returns WHERE business_date BETWEEN @from AND @to)`,
  ).all({ from, to }) as { id: number; full_name: string }[];
  return users.map((u) => {
    const f = financialSummary(ctx, from, to, { userId: u.id });
    const sh = ctx.db.prepare(
      `SELECT COUNT(*) AS shifts, COALESCE(SUM(variance),0) AS variance, SUM(CASE WHEN variance < 0 THEN variance ELSE 0 END) AS shortage,
              SUM(CASE WHEN variance > 0 THEN variance ELSE 0 END) AS overage
       FROM shifts WHERE user_id = ? AND substr(opened_at,1,10) BETWEEN ? AND ?`,
    ).get(u.id, from, to) as Record<string, number>;
    return { userId: u.id, name: u.full_name, invoices: f.invoices, sales: f.salesTotal, netSales: f.netSales, discounts: f.discounts, returns: f.returns, voids: f.voids, avgBasket: f.avgBasket, cash: f.payments.cash, ...sh };
  });
}

export function lowStock(ctx: Ctx, limit = 500) {
  requirePerm(ctx, 'inventory.view');
  return ctx.db.prepare(
    `SELECT * FROM (SELECT p.id, p.name, p.variant_name, p.min_stock, u.symbol AS unit_symbol, s.name AS supplier_name,
            (SELECT COALESCE(SUM(qty),0) FROM product_stock ps WHERE ps.product_id = p.id) AS stock
     FROM products p JOIN units u ON u.id = p.base_unit_id LEFT JOIN suppliers s ON s.id = p.default_supplier_id
     WHERE p.active = 1 AND p.min_stock > 0) WHERE stock <= min_stock ORDER BY (stock * 1.0 / min_stock), name LIMIT ?`,
  ).all(limit);
}

/**
 * Reorder suggestions (never auto-orders). Uses net daily sales velocity over
 * the analysis window, supplier lead time and the configured cover days:
 *   need = velocity × (lead_time + cover_days) + min_stock − stock
 * rounded up to the purchase unit (e.g. whole cartons).
 */
export function reorderSuggestions(ctx: Ctx, opts: { windowDays?: number; supplierId?: number | null } = {}) {
  requirePerm(ctx, 'inventory.view');
  const window = Math.max(7, Math.min(opts.windowDays ?? 30, 180));
  const to = today(ctx);
  const from = addDays(to, -(window - 1));
  const cover = getSetting(ctx.db, 'inventory.reorderCoverDays');
  const rows = ctx.db.prepare(
    `WITH sold AS (
       SELECT si.product_id, SUM(si.base_qty) AS q FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
       WHERE sa.status = 'completed' AND sa.business_date BETWEEN @from AND @to GROUP BY si.product_id),
     ret AS (
       SELECT ri.product_id, SUM(ri.base_qty) AS q FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
       WHERE r.business_date BETWEEN @from AND @to GROUP BY ri.product_id)
     SELECT p.id, p.name, p.variant_name, p.min_stock, p.reorder_qty, p.last_cost, u.symbol AS unit_symbol, u.allow_decimal,
            s.id AS supplier_id, s.name AS supplier_name, COALESCE(s.lead_time_days, 2) AS lead_time,
            (SELECT COALESCE(SUM(qty),0) FROM product_stock ps WHERE ps.product_id = p.id) AS stock,
            COALESCE(sold.q,0) - COALESCE(ret.q,0) AS sold_qty,
            (SELECT pu.factor FROM product_units pu WHERE pu.product_id = p.id AND pu.is_default_purchase = 1 LIMIT 1) AS purchase_factor,
            (SELECT un.name FROM product_units pu JOIN units un ON un.id = pu.unit_id WHERE pu.product_id = p.id AND pu.is_default_purchase = 1 LIMIT 1) AS purchase_unit,
            (SELECT pu.unit_id FROM product_units pu WHERE pu.product_id = p.id AND pu.is_default_purchase = 1 LIMIT 1) AS purchase_unit_id,
            (SELECT MAX(pu2.purchase_date) FROM purchase_items pi JOIN purchases pu2 ON pu2.id = pi.purchase_id WHERE pi.product_id = p.id) AS last_purchase
     FROM products p JOIN units u ON u.id = p.base_unit_id LEFT JOIN suppliers s ON s.id = p.default_supplier_id
     LEFT JOIN sold ON sold.product_id = p.id LEFT JOIN ret ON ret.product_id = p.id
     WHERE p.active = 1 ${opts.supplierId ? 'AND p.default_supplier_id = @sid' : ''}`,
  ).all({ from, to, sid: opts.supplierId ?? null }) as Record<string, any>[];
  const out = [];
  for (const r of rows) {
    const velocity = Math.max(0, r.sold_qty) / window; // base milli per day
    const target = velocity * (r.lead_time + cover) + r.min_stock;
    let need = target - r.stock;
    if (r.reorder_qty && r.stock <= r.min_stock) need = Math.max(need, r.reorder_qty);
    if (need <= 0 || (velocity === 0 && r.stock > r.min_stock)) continue;
    const factor = r.purchase_factor || 1000;
    const units = Math.ceil(need / factor);
    const suggested = units * factor;
    const daysLeft = velocity > 0 ? Math.max(0, Math.floor(r.stock / velocity)) : null;
    out.push({
      productId: r.id, name: r.variant_name ? `${r.name} ${r.variant_name}` : r.name, unitSymbol: r.unit_symbol, stock: r.stock, minStock: r.min_stock,
      dailyVelocity: Math.round(velocity), daysLeft, leadTime: r.lead_time, supplierId: r.supplier_id, supplierName: r.supplier_name,
      suggestedBaseQty: suggested, purchaseUnits: units, purchaseUnit: r.purchase_unit ?? r.unit_symbol, purchaseUnitId: r.purchase_unit_id,
      purchaseFactor: factor, estimatedCost: can(ctx, 'reports.cost') ? Math.round((suggested * r.last_cost) / 1000) : null, lastPurchase: r.last_purchase,
      urgency: daysLeft !== null && daysLeft <= r.lead_time ? 'high' : r.stock <= r.min_stock ? 'medium' : 'low',
    });
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.urgency as keyof typeof rank] - rank[b.urgency as keyof typeof rank] || (a.daysLeft ?? 999) - (b.daysLeft ?? 999));
}

/** Products with stock that have not sold for N days (dead / slow stock). */
export function deadStock(ctx: Ctx, days?: number) {
  requirePerm(ctx, 'inventory.view');
  const d = days ?? getSetting(ctx.db, 'inventory.deadStockDays');
  const since = addDays(today(ctx), -d);
  const showCost = can(ctx, 'reports.cost');
  return ctx.db.prepare(
    `SELECT * FROM (SELECT p.id, p.name, p.variant_name, u.symbol AS unit_symbol, p.created_at, ${showCost ? 'p.avg_cost' : 'NULL AS avg_cost'},
            (SELECT COALESCE(SUM(qty),0) FROM product_stock ps WHERE ps.product_id = p.id) AS stock,
            (SELECT MAX(sa.business_date) FROM sale_items si JOIN sales sa ON sa.id = si.sale_id WHERE si.product_id = p.id AND sa.status = 'completed') AS last_sale
     FROM products p JOIN units u ON u.id = p.base_unit_id WHERE p.active = 1)
     WHERE stock > 0 AND (last_sale IS NULL OR last_sale < @since) AND substr(created_at,1,10) < @since
     ORDER BY COALESCE(last_sale, '0000') LIMIT 1000`,
  ).all({ since });
}

export function expiringBatches(ctx: Ctx, days?: number) {
  requirePerm(ctx, 'inventory.view');
  const d = days ?? getSetting(ctx.db, 'inventory.expiryAlertDays');
  const limit = addDays(today(ctx), d);
  return ctx.db.prepare(
    `SELECT b.id, b.batch_no, b.expiry_date, b.qty, ${can(ctx, 'reports.cost') ? 'b.unit_cost' : 'NULL AS unit_cost'}, p.id AS product_id, p.name, p.variant_name, u.symbol AS unit_symbol, l.name AS location_name,
            CAST(julianday(b.expiry_date) - julianday(@today) AS INTEGER) AS days_left
     FROM batches b JOIN products p ON p.id = b.product_id JOIN units u ON u.id = p.base_unit_id JOIN locations l ON l.id = b.location_id
     WHERE b.qty > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= @limit ORDER BY b.expiry_date LIMIT 1000`,
  ).all({ limit, today: today(ctx) });
}

export type ExpiryTier = 'expired' | 'critical' | 'near' | 'watch';

/** Expiry tiers from the store's settings: expired / ≤ critical / ≤ near / ≤ watch days. */
export function expiryTiers(ctx: Ctx) {
  const critical = Math.max(1, getSetting(ctx.db, 'inventory.expiryCriticalDays'));
  const near = Math.max(critical, getSetting(ctx.db, 'inventory.expiryAlertDays'));
  const watch = Math.max(near, getSetting(ctx.db, 'inventory.expiryWatchDays'));
  const tierOf = (daysLeft: number): ExpiryTier => (daysLeft < 0 ? 'expired' : daysLeft <= critical ? 'critical' : daysLeft <= near ? 'near' : 'watch');
  return { critical, near, watch, tierOf };
}

/**
 * The owner's expiry dashboard: every batch still in stock that expires within the watch horizon (or already
 * expired), with quantity, its own purchase cost and value, supplier, days left, recent sales pace and a
 * suggested action. Suggestions only — nothing is done automatically.
 */
export function expiryOverview(ctx: Ctx) {
  requirePerm(ctx, 'inventory.view');
  const showCost = can(ctx, 'reports.cost');
  const t = today(ctx);
  const { critical, near, watch, tierOf } = expiryTiers(ctx);
  const rows = ctx.db.prepare(
    `SELECT b.id AS batch_id, b.batch_no, b.expiry_date, b.qty, b.initial_qty, b.unit_cost, b.received_at, b.location_id, l.name AS location_name,
            p.id AS product_id, p.name, p.variant_name, p.base_unit_id, u.symbol AS unit_symbol, u.allow_decimal,
            COALESCE(b.supplier_id, pu.supplier_id) AS supplier_id, s.name AS supplier_name, pu.purchase_no,
            CAST(julianday(b.expiry_date) - julianday(@t) AS INTEGER) AS days_left,
            (SELECT COALESCE(SUM(si.base_qty),0) FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
              WHERE si.product_id = p.id AND sa.status = 'completed' AND sa.business_date > date(@t, '-30 days')) AS sold30
     FROM batches b JOIN products p ON p.id = b.product_id JOIN units u ON u.id = p.base_unit_id JOIN locations l ON l.id = b.location_id
     LEFT JOIN purchases pu ON b.ref_type = 'purchase' AND pu.id = b.ref_id
     LEFT JOIN suppliers s ON s.id = COALESCE(b.supplier_id, pu.supplier_id)
     WHERE b.qty > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= @lim
     ORDER BY b.expiry_date, p.name LIMIT 2000`,
  ).all({ t, lim: addDays(t, watch) }) as Record<string, any>[];
  const items = rows.map((r): any => {
    const tier = tierOf(r.days_left);
    const value = Math.round((r.qty * r.unit_cost) / 1000);
    const perDay = r.sold30 / 30;
    // what the current pace will not sell before the date (FEFO is applied by the POS, so this is per batch)
    let unsold = tier === 'expired' ? r.qty : Math.max(0, r.qty - Math.floor(perDay * (r.days_left + 1)));
    if (!r.allow_decimal) unsold = Math.ceil(unsold / 1000) * 1000; // whole pieces, never "36.534 pieces"
    let action: 'dispose' | 'return' | 'promote' | 'monitor';
    if (tier === 'expired') action = r.supplier_id ? 'return' : 'dispose';
    else if (unsold > 0 && r.supplier_id && tier !== 'watch') action = 'return';
    else if (unsold > 0) action = 'promote';
    else action = 'monitor';
    return {
      ...r, tier, unsold, perDay: r.allow_decimal ? Math.round(perDay) : Math.round(perDay / 100) * 100, action,
      unit_cost: showCost ? r.unit_cost : null, value: showCost ? value : null,
    };
  });
  const summary = (['expired', 'critical', 'near', 'watch'] as ExpiryTier[]).map((tier) => {
    const xs = items.filter((i: any) => i.tier === tier);
    return { tier, batches: xs.length, products: new Set(xs.map((i: any) => i.product_id)).size, qty: xs.reduce((a: number, i: any) => a + i.qty, 0), value: showCost ? xs.reduce((a: number, i: any) => a + (i.value ?? 0), 0) : null };
  });
  return { thresholds: { critical, near, watch }, summary, items };
}

export function inventoryValuation(ctx: Ctx) {
  requirePerm(ctx, 'inventory.view');
  const showCost = can(ctx, 'reports.cost');
  const total = ctx.db.prepare(
    `SELECT COUNT(DISTINCT p.id) AS products, COALESCE(SUM(CASE WHEN s.qty > 0 THEN ROUND(s.qty * p.avg_cost / 1000.0) END),0) AS cost_value,
            COALESCE(SUM(CASE WHEN s.qty > 0 THEN ROUND(s.qty * p.sell_price / 1000.0) END),0) AS retail_value,
            SUM(CASE WHEN s.qty < 0 THEN 1 ELSE 0 END) AS negative_count
     FROM products p LEFT JOIN product_stock s ON s.product_id = p.id WHERE p.active = 1`,
  ).get() as Record<string, number>;
  const byCategory = ctx.db.prepare(
    `SELECT COALESCE(c.name,'بدون تصنيف') AS name, COUNT(DISTINCT p.id) AS products,
            COALESCE(SUM(CASE WHEN s.qty > 0 THEN ROUND(s.qty * p.avg_cost / 1000.0) END),0) AS cost_value,
            COALESCE(SUM(CASE WHEN s.qty > 0 THEN ROUND(s.qty * p.sell_price / 1000.0) END),0) AS retail_value
     FROM products p LEFT JOIN product_stock s ON s.product_id = p.id LEFT JOIN categories c ON c.id = p.category_id WHERE p.active = 1 GROUP BY c.id ORDER BY cost_value DESC`,
  ).all() as Record<string, number>[];
  if (!showCost) { total.cost_value = null as any; for (const r of byCategory) r.cost_value = null as any; }
  return { ...total, byCategory };
}

export function debtsReport(ctx: Ctx) {
  requirePerm(ctx, 'reports.view');
  const customers = ctx.db.prepare(`SELECT id, name, phone, balance, credit_limit, (SELECT MAX(created_at) FROM customer_ledger l WHERE l.customer_id = c.id AND l.type = 'payment') AS last_payment FROM customers c WHERE balance <> 0 ORDER BY balance DESC`).all();
  const suppliers = ctx.db.prepare(`SELECT id, name, phone, company, balance, (SELECT MAX(created_at) FROM supplier_ledger l WHERE l.supplier_id = s.id AND l.type = 'payment') AS last_payment FROM suppliers s WHERE balance <> 0 ORDER BY balance DESC`).all();
  const tot = (rows: any[], sign: 1 | -1) => rows.filter((r) => r.balance * sign > 0).reduce((a, r) => a + r.balance, 0);
  return { customers, suppliers, customersOwe: tot(customers, 1), storeOwes: tot(suppliers, 1) };
}

export function purchasesReport(ctx: Ctx, from: string, to: string) {
  requirePerm(ctx, 'purchases.view');
  const total = ctx.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(paid),0) AS paid FROM purchases WHERE business_date BETWEEN ? AND ?`).get(from, to);
  const returns = ctx.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM purchase_returns WHERE business_date BETWEEN ? AND ?`).get(from, to);
  const bySupplier = ctx.db.prepare(
    `SELECT COALESCE(s.name,'بدون مورد') AS name, s.id, COUNT(*) AS count, SUM(p.total) AS total, SUM(p.paid) AS paid, s.balance
     FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.business_date BETWEEN ? AND ? GROUP BY s.id ORDER BY total DESC`,
  ).all(from, to);
  return { total, returns, bySupplier };
}

/* ------------------------------------------------------------------ dashboard & alerts */

export function alerts(ctx: Ctx) {
  const db = ctx.db;
  const out: { key: string; level: 'info' | 'warning' | 'danger'; count?: number; text: string; link: string }[] = [];
  const canInv = can(ctx, 'inventory.view');
  if (canInv) {
    const low = (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT p.min_stock, (SELECT COALESCE(SUM(qty),0) FROM product_stock s WHERE s.product_id = p.id) AS q FROM products p WHERE p.active = 1 AND p.min_stock > 0) WHERE q <= min_stock`).get() as { n: number }).n;
    if (low) out.push({ key: 'low', level: 'warning', count: low, text: `${low} منتج وصل للحد الأدنى للمخزون`, link: '/inventory/low' });
    const neg = (db.prepare(`SELECT COUNT(*) AS n FROM (SELECT product_id, SUM(qty) AS q FROM product_stock GROUP BY product_id) WHERE q < 0`).get() as { n: number }).n;
    if (neg) out.push({ key: 'negative', level: 'danger', count: neg, text: `${neg} منتج رصيده بالسالب — يحتاج جرد أو تسجيل مشتريات`, link: '/products?stock=negative' });
    if (getSetting(db, 'features.expiry')) {
      // tiered expiry alerts: expired (never sellable) / very near / near — each with its most urgent example
      const t = today(ctx);
      const { critical, near } = expiryTiers(ctx);
      const rows = db.prepare(
        `SELECT p.name, u.symbol, SUM(b.qty) AS qty, MIN(b.expiry_date) AS exp, COUNT(*) AS n,
                CASE WHEN b.expiry_date < @t THEN 'expired' WHEN b.expiry_date <= @c THEN 'critical' ELSE 'near' END AS tier
         FROM batches b JOIN products p ON p.id = b.product_id JOIN units u ON u.id = p.base_unit_id
         WHERE b.qty > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= @n
         GROUP BY tier, p.id ORDER BY MIN(b.expiry_date)`,
      ).all({ t, c: addDays(t, critical), n: addDays(t, near) }) as { name: string; symbol: string; qty: number; exp: string; n: number; tier: string }[];
      const q = (v: number) => formatQty(v);
      const days = (d: string) => Math.max(0, Math.round((Date.parse(`${d}T00:00:00`) - Date.parse(`${t}T00:00:00`)) / 86_400_000));
      const expired = rows.filter((r) => r.tier === 'expired');
      const crit = rows.filter((r) => r.tier === 'critical');
      const nearRows = rows.filter((r) => r.tier === 'near');
      if (expired.length) {
        const top = expired[0];
        out.push({ key: 'expired', level: 'danger', count: expired.reduce((a, r) => a + r.n, 0),
          text: `⛔ ${expired.length} منتج عليه كمية منتهية الصلاحية لا تُباع — مثل ${q(top.qty)} ${top.symbol} من ${top.name}. سجّلها كتالف أو أرجعها للمورد.`, link: '/inventory/expiry' });
      }
      if (crit.length) {
        const top = crit[0];
        out.push({ key: 'expiring', level: 'danger', count: crit.reduce((a, r) => a + r.n, 0),
          text: `⚠️ يوجد ${q(top.qty)} ${top.symbol} من ${top.name} ستنتهي خلال ${days(top.exp)} يوم${crit.length > 1 ? ` (+${crit.length - 1} منتج آخر خلال ${critical} أيام)` : ''}.`, link: '/inventory/expiry' });
      }
      if (nearRows.length) {
        const top = nearRows[0];
        out.push({ key: 'expiring_near', level: 'warning', count: nearRows.reduce((a, r) => a + r.n, 0),
          text: `⚠️ يوجد ${q(top.qty)} ${top.symbol} من ${top.name} ستنتهي خلال ${days(top.exp)} يومًا${nearRows.length > 1 ? ` (+${nearRows.length - 1} منتج آخر خلال ${near} يومًا)` : ''}.`, link: '/inventory/expiry' });
      }
    }
  }
  if (can(ctx, 'sales.view')) {
    const held = (db.prepare('SELECT COUNT(*) AS n FROM held_sales').get() as { n: number }).n;
    if (held) out.push({ key: 'held', level: 'info', count: held, text: `${held} فاتورة معلقة`, link: '/pos?held=1' });
  }
  if (can(ctx, 'purchases.view')) {
    const due = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(balance),0) AS t FROM suppliers WHERE balance > 0 AND active = 1`).get() as { n: number; t: number };
    if (due.n) out.push({ key: 'supplier_due', level: 'info', count: due.n, text: `مستحقات لـ ${due.n} مورد`, link: '/suppliers?due=1' });
  }
  if (can(ctx, 'customers.manage')) {
    const cd = db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE balance > 0 AND active = 1`).get() as { n: number };
    if (cd.n) out.push({ key: 'customer_due', level: 'info', count: cd.n, text: `${cd.n} عميل عليهم مديونية`, link: '/customers?due=1' });
  }
  const maxH = getSetting(db, 'shift.maxHours');
  const now = ctx.now().getTime();
  const longShifts = openShifts(ctx).filter((s) => (now - Date.parse(s.opened_at)) / 3_600_000 > maxH && (s.user_id === ctx.user?.id || can(ctx, 'shifts.view_all')));
  if (longShifts.length) out.push({ key: 'shift_long', level: 'warning', count: longShifts.length, text: `وردية مفتوحة منذ أكثر من ${maxH} ساعة (${longShifts.map((s) => s.user_name).join('، ')})`, link: '/shifts' });
  if (can(ctx, 'backup.manage')) {
    // gentle reminder: once a week without any backup (auto or manual). Counted from the
    // last backup, or from the day the store was set up when no backup exists yet.
    const last = getSetting(db, 'backup.lastAt') || (db.prepare('SELECT MIN(created_at) AS t FROM users').get() as { t: string | null }).t;
    const days = last ? Math.floor((now - Date.parse(last)) / 86_400_000) : 0;
    if (days >= 7) out.push({ key: 'backup', level: 'warning', count: days, text: `⚠️ لم يتم إنشاء نسخة احتياطية منذ ${days} أيام`, link: '/backup' });
  }

  if (canInv) {
    const dd = getSetting(db, 'inventory.deadStockDays');
    const since = addDays(today(ctx), -dd);
    const dead = (db.prepare(
      `SELECT COUNT(*) AS n FROM products p WHERE p.active = 1 AND substr(p.created_at,1,10) < @s AND (SELECT COALESCE(SUM(qty),0) FROM product_stock ps WHERE ps.product_id = p.id) > 0
         AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales sa ON sa.id = si.sale_id WHERE si.product_id = p.id AND sa.business_date >= @s AND sa.status = 'completed')`,
    ).get({ s: since }) as { n: number }).n;
    if (dead) out.push({ key: 'dead', level: 'info', count: dead, text: `${dead} منتج راكد لم يُبع منذ ${dd} يومًا`, link: '/reports?tab=dead' });
  }
  return out;
}

export function dashboard(ctx: Ctx) {
  const d = today(ctx);
  const canReports = can(ctx, 'reports.view');
  const todaySummary = canReports ? financialSummary(ctx, d, d) : financialSummary(ctx, d, d, { userId: ctx.user?.id });
  const from = addDays(d, -13);
  const trend = canReports ? dailyTrend(ctx, from, d) : [];
  const top = canReports ? productPerformance(ctx, addDays(d, -6), d, { sort: 'qty', limit: 8 }) : [];
  const yesterday = canReports ? financialSummary(ctx, addDays(d, -1), addDays(d, -1)) : null;
  return { date: d, today: todaySummary, yesterday, trend, top, alerts: alerts(ctx), scope: canReports ? 'store' : 'mine' };
}

/* ------------------------------------------------------------------ daily closing */

export function dayClosingPreview(ctx: Ctx, date?: string) {
  requirePerm(ctx, 'day.close');
  const d = date ?? today(ctx);
  const summary = financialSummary(ctx, d, d);
  const shifts = ctx.db.prepare(
    `SELECT s.id, s.status, s.opening_cash, s.expected_cash, s.counted_cash, s.variance, s.opened_at, s.closed_at, u.full_name AS user_name
     FROM shifts s JOIN users u ON u.id = s.user_id WHERE substr(s.opened_at,1,10) = ? OR (s.status = 'open') ORDER BY s.id`,
  ).all(d) as Record<string, any>[];
  const variance = shifts.filter((s) => s.status === 'closed').reduce((a, s) => a + (s.variance ?? 0), 0);
  const closed = ctx.db.prepare('SELECT * FROM day_closings WHERE business_date = ?').get(d) as Record<string, any> | undefined;
  const collections = ctx.db.prepare(`SELECT party_type, method, COALESCE(SUM(amount),0) AS amount FROM party_payments WHERE business_date = ? GROUP BY party_type, method`).all(d);
  const purchases = ctx.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(paid),0) AS paid FROM purchases WHERE business_date = ?`).get(d);
  return { date: d, summary, shifts, cashVariance: variance, openShifts: shifts.filter((s) => s.status === 'open').length, collections, purchases, closed: closed ? { ...closed, summary: JSON.parse(closed.summary) } : null };
}

export function closeDay(ctx: Ctx, date?: string) {
  requirePerm(ctx, 'day.close');
  return tx(ctx, () => {
    const preview = dayClosingPreview(ctx, date);
    if (preview.closed) throw new AppError('DAY_ALREADY_CLOSED');
    const info = ctx.db.prepare('INSERT INTO day_closings(business_date, summary, closed_by, closed_at) VALUES (?, ?, ?, ?)').run(preview.date, JSON.stringify({ ...preview, closed: null }), ctx.user?.id ?? null, ts(ctx));
    audit(ctx, 'day.close', 'day_closing', Number(info.lastInsertRowid), undefined, { date: preview.date, netSales: preview.summary.netSales });
    return { id: Number(info.lastInsertRowid), ...preview };
  });
}

export function listDayClosings(ctx: Ctx) {
  requirePerm(ctx, 'day.close');
  return ctx.db.prepare('SELECT d.id, d.business_date, d.closed_at, d.backup_file, u.full_name AS closed_by_name, d.summary FROM day_closings d LEFT JOIN users u ON u.id = d.closed_by ORDER BY d.business_date DESC LIMIT 366').all()
    .map((r: any) => ({ ...r, summary: JSON.parse(r.summary).summary }));
}
