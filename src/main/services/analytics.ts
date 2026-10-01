/**
 * InventoryAnalyticsService + SalesAnalyticsService.
 *
 * Pure rules and statistics over the store's own data — no randomness and no
 * "AI". Every classification carries the numbers and the Arabic reason that
 * produced it, and thresholds adapt to each store (percentiles, the product's
 * own selling rhythm) instead of one fixed rule for everybody.
 */
import { type Ctx, addDays, can, getSetting, requirePerm, today } from './context';

export type ProductClass = 'hot' | 'stable' | 'slow' | 'dead' | 'excess' | 'expiry' | 'new';

export const CLASS_LABELS: Record<ProductClass, string> = {
  hot: 'عليه سحب قوي',
  stable: 'مستقر',
  slow: 'حركته ضعيفة',
  dead: 'بضاعة راكدة',
  excess: 'مخزون زائد',
  expiry: 'معرض للانتهاء',
  new: 'جديد — بيانات غير كافية',
};

export interface ProductMetrics {
  id: number; name: string; categoryId: number | null; category: string | null; unitSymbol: string; allowDecimal: boolean;
  price: number; avgCost: number; marginUnit: number; marginPct: number | null;
  stock: number; stockValue: number; ageDays: number; effWindow: number;
  soldQty: number; invoices: number; revenue: number; cost: number; profit: number;
  velocity: number; // base milli per day over the analysis window
  weekVelocity: number; prevVelocity: number | null; trend: number | null;
  daysCover: number | null; // null when nothing sells (infinite cover)
  turnover: number | null; // annualised COGS / stock value
  lastSale: string | null; daysSinceLast: number | null; longGap: number | null; // typical days between sales (180d)
  /** expiredQty: already past its date — must be disposed, never discounted. atRiskQty: still sellable but will not sell in time. */
  expiry: { batchQty: number; nearestDate: string; daysLeft: number; atRiskQty: number; expiredQty: number } | null;
  classes: ProductClass[];
  primary: ProductClass;
  reasons: string[];
  hasPurchaseUnit?: { unitId: number; factor: number; name: string } | null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00`) - Date.parse(`${a}T00:00:00`)) / 86_400_000);
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const fmtQ = (m: number) => {
  const v = m / 1000;
  return Number.isInteger(v) ? String(v) : v.toFixed(v < 10 ? 2 : 1).replace(/\.?0+$/, '');
};

/** Compute metrics + dynamic classification for every active product. */
export function productMetrics(ctx: Ctx, opts: { windowDays?: number; asOf?: string } = {}): ProductMetrics[] {
  const db = ctx.db;
  const W = Math.max(7, Math.min(opts.windowDays ?? getSetting(db, 'intel.windowDays'), 180));
  const to = opts.asOf ?? today(ctx);
  const from = addDays(to, -(W - 1));
  const prevFrom = addDays(from, -W);
  const prevTo = addDays(from, -1);
  const weekFrom = addDays(to, -6);
  const longFrom = addDays(to, -179);
  const rows = db.prepare(
    `WITH sold AS (
       SELECT si.product_id,
              SUM(CASE WHEN s.business_date BETWEEN @from AND @to THEN si.base_qty ELSE 0 END) AS q,
              COUNT(DISTINCT CASE WHEN s.business_date BETWEEN @from AND @to THEN si.sale_id END) AS inv,
              SUM(CASE WHEN s.business_date BETWEEN @from AND @to THEN si.net_revenue ELSE 0 END) AS rev,
              SUM(CASE WHEN s.business_date BETWEEN @from AND @to THEN si.cost_total ELSE 0 END) AS cost,
              SUM(CASE WHEN s.business_date BETWEEN @weekFrom AND @to THEN si.base_qty ELSE 0 END) AS wq,
              SUM(CASE WHEN s.business_date BETWEEN @prevFrom AND @prevTo THEN si.base_qty ELSE 0 END) AS pq,
              COUNT(DISTINCT CASE WHEN s.business_date BETWEEN @longFrom AND @to THEN si.sale_id END) AS linv,
              MAX(s.business_date) AS last_sale
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.status = 'completed' AND s.business_date >= @prevFrom AND s.business_date <= @to
       GROUP BY si.product_id),
     lastever AS (
       SELECT si.product_id, MAX(s.business_date) AS d FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status = 'completed' GROUP BY si.product_id),
     ret AS (
       SELECT ri.product_id,
              SUM(CASE WHEN r.business_date BETWEEN @from AND @to THEN ri.base_qty ELSE 0 END) AS q,
              SUM(CASE WHEN r.business_date BETWEEN @from AND @to THEN ri.net_revenue ELSE 0 END) AS rev,
              SUM(CASE WHEN r.business_date BETWEEN @from AND @to THEN ri.cost_total ELSE 0 END) AS cost
       FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id WHERE r.business_date BETWEEN @from AND @to GROUP BY ri.product_id),
     firstmv AS (SELECT product_id, MIN(business_date) AS d FROM stock_movements GROUP BY product_id)
     SELECT p.id, p.name, p.variant_name, p.category_id, c.name AS category, u.symbol AS unit_symbol, u.allow_decimal, p.sell_price, p.avg_cost,
            substr(p.created_at, 1, 10) AS created, fm.d AS first_move,
            (SELECT COALESCE(SUM(qty),0) FROM product_stock ps WHERE ps.product_id = p.id) AS stock,
            COALESCE(sold.q,0) - COALESCE(ret.q,0) AS q, COALESCE(sold.inv,0) AS inv, COALESCE(sold.rev,0) - COALESCE(ret.rev,0) AS rev,
            COALESCE(sold.cost,0) - COALESCE(ret.cost,0) AS cost, COALESCE(sold.wq,0) AS wq, COALESCE(sold.pq,0) AS pq, COALESCE(sold.linv,0) AS linv,
            le.d AS last_sale
     FROM products p JOIN units u ON u.id = p.base_unit_id LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN sold ON sold.product_id = p.id LEFT JOIN ret ON ret.product_id = p.id LEFT JOIN lastever le ON le.product_id = p.id
     LEFT JOIN firstmv fm ON fm.product_id = p.id
     WHERE p.active = 1`,
  ).all({ from, to, prevFrom, prevTo, weekFrom, longFrom }) as any[];

  const expiryOn = getSetting(db, 'features.expiry');
  const expiryHorizon = addDays(to, Math.max(getSetting(db, 'inventory.expiryAlertDays'), 30) * 2);
  const batchRows = expiryOn
    ? (db.prepare(`SELECT product_id, expiry_date, SUM(qty) AS qty FROM batches WHERE qty > 0 AND expiry_date IS NOT NULL AND expiry_date <= ? GROUP BY product_id, expiry_date ORDER BY expiry_date`).all(expiryHorizon) as { product_id: number; expiry_date: string; qty: number }[])
    : [];
  const batchesBy = new Map<number, { expiry_date: string; qty: number }[]>();
  for (const b of batchRows) { if (!batchesBy.has(b.product_id)) batchesBy.set(b.product_id, []); batchesBy.get(b.product_id)!.push(b); }

  const minAge = getSetting(db, 'intel.minAgeDays');
  const deadDays = getSetting(db, 'inventory.deadStockDays');
  const deadMult = getSetting(db, 'intel.deadMultiplier');
  const excessCover = getSetting(db, 'intel.excessCoverDays');

  const out: ProductMetrics[] = rows.map((r) => {
    const startDate = [r.created, r.first_move].filter(Boolean).sort()[0] ?? to;
    const ageDays = Math.max(0, daysBetween(startDate, to)) + 1;
    const effWindow = Math.max(1, Math.min(W, ageDays));
    const soldQty = Math.max(0, r.q);
    const velocity = soldQty / effWindow;
    const weekVelocity = r.wq / Math.max(1, Math.min(7, ageDays));
    const prevVelocity = ageDays > W ? r.pq / W : null;
    const trend = prevVelocity && prevVelocity > 0 ? velocity / prevVelocity : null;
    const stock = r.stock;
    const avgCost = r.avg_cost ?? 0;
    const stockValue = stock > 0 ? Math.round((stock * avgCost) / 1000) : 0;
    const daysCover = stock <= 0 ? 0 : velocity > 0 ? stock / velocity : null;
    const annualCogs = (r.cost * 365) / effWindow;
    const turnover = stockValue > 0 ? annualCogs / stockValue : null;
    const daysSinceLast = r.last_sale ? daysBetween(r.last_sale, to) : null;
    const longGap = r.linv > 0 ? Math.min(ageDays, 180) / r.linv : null;
    const marginUnit = r.sell_price - avgCost;
    const marginPct = r.sell_price > 0 && avgCost > 0 ? (marginUnit / r.sell_price) * 100 : null;
    let expiry: ProductMetrics['expiry'] = null;
    const bs = batchesBy.get(r.id);
    if (bs?.length) {
      // quantity that will NOT sell before each batch expires, at the current pace (FEFO order).
      // Batches already past their date are counted separately: they are for disposal, not for an offer.
      const expiredQty = bs.filter((b) => b.expiry_date < to).reduce((a, b) => a + b.qty, 0);
      const sellable = bs.filter((b) => b.expiry_date >= to);
      let sellableBefore = 0;
      let atRisk = 0;
      for (const b of sellable) {
        const daysLeft = Math.max(0, daysBetween(to, b.expiry_date));
        const capacity = Math.max(0, velocity * daysLeft - sellableBefore);
        const sells = Math.min(b.qty, capacity);
        sellableBefore += sells;
        atRisk += b.qty - sells;
      }
      // count products are rounded to whole units (no '97.4 pieces')
      const risk = r.allow_decimal ? Math.round(atRisk) : Math.round(atRisk / 1000) * 1000;
      const nearest = sellable[0] ?? bs[0];
      expiry = { batchQty: bs.reduce((a, b) => a + b.qty, 0), nearestDate: nearest.expiry_date, daysLeft: daysBetween(to, nearest.expiry_date), atRiskQty: risk, expiredQty };
    }
    return {
      id: r.id, name: r.variant_name ? `${r.name} ${r.variant_name}` : r.name, categoryId: r.category_id, category: r.category, unitSymbol: r.unit_symbol, allowDecimal: !!r.allow_decimal,
      price: r.sell_price, avgCost, marginUnit, marginPct, stock, stockValue, ageDays, effWindow, soldQty, invoices: r.inv, revenue: r.rev, cost: r.cost, profit: r.rev - r.cost,
      velocity, weekVelocity, prevVelocity, trend, daysCover, turnover, lastSale: r.last_sale, daysSinceLast, longGap, expiry,
      classes: [], primary: 'stable' as ProductClass, reasons: [],
    };
  });

  // adaptive thresholds: percentiles of THIS store's selling products
  const selling = out.filter((m) => m.velocity > 0 && m.ageDays >= minAge).map((m) => m.velocity).sort((a, b) => a - b);
  const enough = selling.length >= 5;
  const hotCut = enough ? percentile(selling, getSetting(db, 'intel.hotPercentile')) : Infinity;
  const slowCut = enough ? percentile(selling, getSetting(db, 'intel.slowPercentile')) : -1;
  // category median days of cover (what is "normal" for this kind of product)
  const covers = new Map<string, number[]>();
  for (const m of out) if (m.daysCover !== null && m.daysCover > 0 && m.velocity > 0) {
    const k = String(m.categoryId ?? 0);
    if (!covers.has(k)) covers.set(k, []);
    covers.get(k)!.push(m.daysCover);
  }
  const medianCover = new Map<string, number>();
  for (const [k, v] of covers) { v.sort((a, b) => a - b); medianCover.set(k, v[Math.floor(v.length / 2)]); }

  for (const m of out) {
    const c: ProductClass[] = [];
    const reasons: string[] = [];
    const u = m.unitSymbol;
    const isNew = m.ageDays < minAge;
    if (m.expiry && (m.expiry.atRiskQty > 0 || m.expiry.expiredQty > 0)) {
      c.push('expiry');
      if (m.expiry.expiredQty > 0) reasons.push(`توجد ${fmtQ(m.expiry.expiredQty)} ${u} منتهية الصلاحية — يجب رفعها من الرف وتسجيلها كتالف، ولا تُباع.`);
      if (m.expiry.atRiskQty > 0) {
        reasons.push(m.expiry.daysLeft === 0
          ? `صلاحية جزء من الكمية تنتهي اليوم، وبمعدل البيع الحالي ستتبقى حوالي ${fmtQ(m.expiry.atRiskQty)} ${u} بدون بيع.`
          : `أقرب صلاحية بعد ${m.expiry.daysLeft} يوم، وبمعدل البيع الحالي ستتبقى حوالي ${fmtQ(m.expiry.atRiskQty)} ${u} بدون بيع.`);
      }
    }
    if (!isNew && m.stock > 0) {
      const threshold = m.longGap ? Math.max(deadDays, Math.ceil(deadMult * m.longGap)) : deadDays;
      const idle = m.daysSinceLast ?? m.ageDays;
      if (m.soldQty === 0 && idle >= threshold) {
        c.push('dead');
        reasons.push(m.lastSale
          ? `لم يُبع منذ ${idle} يوم، بينما معدله المعتاد بيعة كل ${m.longGap ? Math.round(m.longGap) : '—'} يوم.`
          : `لم يُبع أبدًا منذ إضافته قبل ${m.ageDays} يوم.`);
      }
    }
    if (!isNew && m.stock > 0 && m.velocity > 0 && m.daysCover !== null) {
      const norm = medianCover.get(String(m.categoryId ?? 0)) ?? excessCover;
      const limit = Math.max(excessCover, 3 * norm);
      if (m.daysCover > limit) {
        c.push('excess');
        reasons.push(`المخزون (${fmtQ(m.stock)} ${u}) يكفي تقريبًا ${Math.round(m.daysCover)} يوم، والمعتاد لهذا التصنيف ${Math.round(norm)} يوم.`);
      }
    }
    if (!isNew && m.velocity > 0 && enough && m.velocity <= slowCut && !c.includes('dead')) {
      c.push('slow');
      reasons.push(`متوسط البيع ${fmtQ(m.velocity)} ${u} يوميًا — من أقل ${getSetting(db, 'intel.slowPercentile')}% من منتجات المحل حركة.`);
    }
    if (!isNew && enough && m.velocity >= hotCut && m.invoices >= 3) {
      c.push('hot');
      reasons.push(`متوسط البيع ${fmtQ(m.velocity)} ${u} يوميًا في ${m.invoices} فاتورة — من أعلى ${100 - getSetting(db, 'intel.hotPercentile')}% حركة.`);
    }
    if (m.trend !== null && m.trend <= 0.5 && m.prevVelocity && m.soldQty > 0) reasons.push(`الطلب انخفض للنصف تقريبًا مقارنة بالفترة السابقة.`);
    if (m.trend !== null && m.trend >= 1.8) reasons.push(`الطلب زاد ${m.trend.toFixed(1)} مرة مقارنة بالفترة السابقة.`);
    if (isNew) c.push('new');
    const order: ProductClass[] = ['expiry', 'dead', 'excess', 'slow', 'hot', 'new'];
    m.classes = c.length ? c : ['stable'];
    m.primary = order.find((x) => c.includes(x)) ?? 'stable';
    m.reasons = reasons;
  }
  return out;
}

export function intelOverview(ctx: Ctx) {
  requirePerm(ctx, 'reports.view');
  const metrics = productMetrics(ctx);
  const counts = Object.fromEntries((Object.keys(CLASS_LABELS) as ProductClass[]).map((k) => [k, metrics.filter((m) => m.classes.includes(k)).length]));
  const deadCapitalOf = (k: ProductClass[]) => metrics.filter((m) => m.classes.some((c) => k.includes(c))).reduce((a, m) => a + m.stockValue, 0);
  const showCost = can(ctx, 'reports.cost');
  return {
    counts,
    deadCapital: showCost ? deadCapitalOf(['dead', 'slow', 'excess']) : null,
    deadOnlyCapital: showCost ? deadCapitalOf(['dead']) : null,
    expiryValue: showCost ? metrics.filter((m) => m.expiry && m.expiry.atRiskQty > 0).reduce((a, m) => a + Math.round((m.expiry!.atRiskQty * m.avgCost) / 1000), 0) : null,
    totalStockValue: showCost ? metrics.reduce((a, m) => a + m.stockValue, 0) : null,
    productsAnalyzed: metrics.length,
    windowDays: getSetting(ctx.db, 'intel.windowDays'),
    dataSufficient: metrics.filter((m) => m.velocity > 0 && m.ageDays >= getSetting(ctx.db, 'intel.minAgeDays')).length >= 5,
  };
}

export function classifiedProducts(ctx: Ctx, opts: { cls?: ProductClass | null; sort?: 'cover' | 'value' | 'velocity' | 'idle' } = {}) {
  requirePerm(ctx, 'reports.view');
  let rows = productMetrics(ctx);
  if (opts.cls) rows = rows.filter((m) => m.classes.includes(opts.cls!));
  const sorters: Record<string, (a: ProductMetrics, b: ProductMetrics) => number> = {
    cover: (a, b) => (b.daysCover ?? 1e9) - (a.daysCover ?? 1e9),
    value: (a, b) => b.stockValue - a.stockValue,
    velocity: (a, b) => b.velocity - a.velocity,
    idle: (a, b) => (b.daysSinceLast ?? b.ageDays) - (a.daysSinceLast ?? a.ageDays),
  };
  rows.sort(sorters[opts.sort ?? 'value']);
  const showCost = can(ctx, 'reports.cost');
  return rows.slice(0, 1000).map((m) => (showCost ? m : { ...m, avgCost: null, stockValue: null, profit: null, cost: null, marginUnit: null, marginPct: null }));
}

/** Demand leaders by four different measures (spec: not only "best selling"). */
export function demandLeaders(ctx: Ctx, limit = 10) {
  requirePerm(ctx, 'reports.view');
  const m = productMetrics(ctx).filter((x) => x.soldQty > 0);
  const top = (f: (x: ProductMetrics) => number) => [...m].sort((a, b) => f(b) - f(a)).slice(0, limit);
  const showCost = can(ctx, 'reports.cost');
  return {
    byQty: top((x) => x.velocity),
    byInvoices: top((x) => x.invoices),
    byTurnover: top((x) => x.turnover ?? 0).filter((x) => x.turnover !== null),
    byProfit: showCost ? top((x) => x.profit) : [],
  };
}

export interface BasketPair { a: number; b: number; aName: string; bName: string; both: number; nA: number; nB: number; confAB: number; confBA: number; lift: number }

/**
 * Products bought together. Only reported when the store has enough
 * invoices and each pair appears in enough of them — no invented relations.
 */
export function basketPairs(ctx: Ctx, opts: { days?: number } = {}): { sufficient: boolean; invoices: number; minInvoices: number; pairs: BasketPair[] } {
  requirePerm(ctx, 'reports.view');
  const db = ctx.db;
  const from = addDays(today(ctx), -((opts.days ?? 90) - 1));
  const minInv = getSetting(db, 'intel.basketMinInvoices');
  const minPair = getSetting(db, 'intel.basketMinPair');
  const N = (db.prepare(`SELECT COUNT(*) AS n FROM sales WHERE status = 'completed' AND business_date >= ? AND items_count >= 1`).get(from) as { n: number }).n;
  if (N < minInv) return { sufficient: false, invoices: N, minInvoices: minInv, pairs: [] };
  const rows = db.prepare(
    `WITH s AS (SELECT DISTINCT si.sale_id, si.product_id FROM sale_items si JOIN sales sa ON sa.id = si.sale_id WHERE sa.status = 'completed' AND sa.business_date >= @from),
          cnt AS (SELECT product_id, COUNT(*) AS n FROM s GROUP BY product_id HAVING n >= @minPair)
     SELECT x.product_id AS a, y.product_id AS b, COUNT(*) AS both, ca.n AS nA, cb.n AS nB, pa.name AS aName, pb.name AS bName
     FROM s x JOIN s y ON x.sale_id = y.sale_id AND x.product_id < y.product_id
     JOIN cnt ca ON ca.product_id = x.product_id JOIN cnt cb ON cb.product_id = y.product_id
     JOIN products pa ON pa.id = x.product_id JOIN products pb ON pb.id = y.product_id
     WHERE pa.active = 1 AND pb.active = 1
     GROUP BY x.product_id, y.product_id HAVING both >= @minPair ORDER BY both DESC LIMIT 200`,
  ).all({ from, minPair }) as { a: number; b: number; both: number; nA: number; nB: number; aName: string; bName: string }[];
  const pairs = rows.map((r) => ({ ...r, confAB: r.both / r.nA, confBA: r.both / r.nB, lift: (r.both * N) / (r.nA * r.nB) }))
    .filter((p) => p.lift >= 1.2)
    .sort((x, y) => y.both * y.lift - x.both * x.lift);
  return { sufficient: true, invoices: N, minInvoices: minInv, pairs: pairs.slice(0, 50) };
}

/**
 * Seasonal signals: compares the coming 30 days LAST YEAR with that product's
 * average 30-day sales over the year. Needs at least 12 months of history.
 */
export function seasonalSignals(ctx: Ctx) {
  requirePerm(ctx, 'reports.view');
  const db = ctx.db;
  const t = today(ctx);
  const first = (db.prepare(`SELECT MIN(business_date) AS d FROM sales WHERE status = 'completed'`).get() as { d: string | null }).d;
  if (!first || daysBetween(first, t) < 365) return { sufficient: false, historyDays: first ? daysBetween(first, t) : 0, items: [] as any[] };
  const yearFrom = addDays(t, -365);
  const nextFrom = addDays(t, -365);
  const nextTo = addDays(t, -335);
  const rows = db.prepare(
    `SELECT p.id, p.name, u.symbol AS unit_symbol,
            SUM(CASE WHEN s.business_date BETWEEN @yf AND @t THEN si.base_qty ELSE 0 END) AS year_qty,
            SUM(CASE WHEN s.business_date BETWEEN @nf AND @nt THEN si.base_qty ELSE 0 END) AS next_qty
     FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id JOIN units u ON u.id = p.base_unit_id
     WHERE s.status = 'completed' AND s.business_date >= @yf AND p.active = 1 GROUP BY p.id`,
  ).all({ yf: yearFrom, t, nf: nextFrom, nt: nextTo }) as { id: number; name: string; unit_symbol: string; year_qty: number; next_qty: number }[];
  const items = rows
    .map((r) => ({ ...r, avg30: (r.year_qty * 30) / 365, ratio: r.year_qty > 0 ? r.next_qty / ((r.year_qty * 30) / 365) : 0 }))
    .filter((r) => r.next_qty >= 10_000 && r.ratio >= 1.6)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 20)
    .map((r) => ({ ...r, text: `في نفس الفترة من العام الماضي بيع ${fmtQ(r.next_qty)} ${r.unit_symbol} — حوالي ${r.ratio.toFixed(1)} ضعف المعتاد. قد تحتاج زيادة المخزون قبل بداية الفترة.` }));
  return { sufficient: true, historyDays: daysBetween(first, t), items };
}
