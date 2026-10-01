/**
 * PromotionRecommendationService
 *
 * suggest -> owner review -> approve -> execute -> measure.
 * Nothing here changes a price or activates a promotion on its own: approval
 * is an explicit owner action, and every suggestion is simulated with the
 * real current prices and average costs before it is shown. Options that
 * would lose money or fall below the minimum margin are never presented as
 * "good" — a safer alternative is offered instead and the rejected option is
 * explained.
 */
import { AppError } from '../../shared/errors';
import { formatMoney } from '../../shared/money';
import { type Ctx, addDays, audit, can, getSetting, requirePerm, requirePermOrApproval, setSettingRaw, today, ts, tx } from './context';
import { basketPairs, productMetrics, type ProductMetrics } from './analytics';
import { reorderSuggestions } from './reports';

export type SuggestionKind = 'clearance' | 'pair' | 'bundle' | 'expiry' | 'quantity';

export interface Proposal {
  type: 'percent' | 'cross' | 'combo';
  productId: number;
  rewardProductId?: number | null;
  minQty: number; // base milli of A per deal
  rewardQty?: number; // base milli of B per deal
  rewardType?: 'free' | 'percent' | null;
  value: number; // percent x100 for percent/cross-percent; combo total price (minor) for combo
  maxPerInvoice?: number | null;
  days: number;
  name: string;
}

export interface Simulation {
  dealRevenueFull: number; dealCost: number; profitBefore: number; discount: number; profitAfter: number; revenueAfter: number;
  marginBeforePct: number | null; marginAfterPct: number | null; effectiveDiscountPct: number;
  targetQty: number; deals: number; promoCostTotal: number; projectedProfit: number; capitalFreed: number; rewardUsed: number;
  flags: { loss: boolean; lowMargin: boolean; overDiscount: boolean; belowCost: boolean; giftHeavy: boolean; rewardShort: boolean };
  unsafe: boolean;
  warnings: string[];
}

const VERDICT_TEXT = { good: 'فرصة جيدة لتصريف المخزون', ok: 'مناسب لتحريك المنتج', review: 'يحتاج مراجعة بسبب انخفاض هامش الربح' } as const;
/** Below this cost value (minor units) an expiring quantity is not worth an offer — the expiry alert covers it. */
const MIN_EXPIRY_VALUE = 2000;
/** Ranking penalty so offers that need review never crowd out safe ones. */
const REVIEW_PENALTY = 25;

function cur(ctx: Ctx) {
  return { code: getSetting(ctx.db, 'currency.code'), symbol: getSetting(ctx.db, 'currency.symbol'), digits: getSetting(ctx.db, 'ui.digits') };
}
const q = (m: number) => { const v = m / 1000; return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ''); };
const arDate = (iso: string) => { const [y, mo, d] = iso.split('-'); return `${d}/${mo}/${y}`; };

function period(ctx: Ctx): string { return today(ctx).slice(0, 7); }

/** Per-deal economics + safety flags for a proposal, using live prices and average cost. */
export function simulate(ctx: Ctx, p: Proposal, metrics?: Map<number, ProductMetrics>, targetQty?: number): Simulation {
  const db = ctx.db;
  const load = (id: number) => db.prepare('SELECT id, name, sell_price, avg_cost, active FROM products WHERE id = ?').get(id) as { id: number; name: string; sell_price: number; avg_cost: number; active: number } | undefined;
  const a = load(p.productId);
  if (!a) throw new AppError('NOT_FOUND');
  const b = p.rewardProductId ? load(p.rewardProductId) : undefined;
  if (p.rewardProductId && !b) throw new AppError('NOT_FOUND');
  const amt = (price: number, qty: number) => Math.round((price * qty) / 1000);
  const aRev = amt(a.sell_price, p.minQty);
  const bRev = b ? amt(b.sell_price, p.rewardQty ?? 0) : 0;
  const aCost = amt(a.avg_cost, p.minQty);
  const bCost = b ? amt(b.avg_cost, p.rewardQty ?? 0) : 0;
  const dealRevenueFull = aRev + bRev;
  const dealCost = aCost + bCost;
  let discount = 0;
  if (p.type === 'percent') discount = Math.round((aRev * p.value) / 10000);
  else if (p.type === 'cross') discount = p.rewardType === 'percent' ? Math.round((bRev * p.value) / 10000) : bRev;
  else discount = Math.max(0, dealRevenueFull - p.value);
  const profitBefore = dealRevenueFull - dealCost;
  const profitAfter = profitBefore - discount;
  const revenueAfter = dealRevenueFull - discount;
  const marginBeforePct = dealRevenueFull > 0 ? (profitBefore / dealRevenueFull) * 100 : null;
  const marginAfterPct = revenueAfter > 0 ? (profitAfter / revenueAfter) * 100 : null;
  const effectiveDiscountPct = dealRevenueFull > 0 ? (discount / dealRevenueFull) * 100 : 0;
  const minMargin = getSetting(db, 'intel.minMarginPct');
  const maxDisc = getSetting(db, 'intel.maxDiscountPct');
  const mA = metrics?.get(a.id);
  const mB = b ? metrics?.get(b.id) : undefined;
  const target = Math.max(0, Math.round(targetQty ?? (mA ? Math.max(0, mA.sellableStock - mA.velocity * 30) : 0)));
  const deals = p.minQty > 0 ? Math.ceil(target / p.minQty) : 0;
  const rewardUsed = b ? deals * (p.rewardQty ?? 0) : 0;
  const flags = {
    loss: profitAfter < 0,
    lowMargin: marginAfterPct !== null && marginAfterPct < minMargin,
    overDiscount: effectiveDiscountPct > maxDisc,
    belowCost: p.type === 'percent' && a.avg_cost > 0 && Math.round(a.sell_price * (1 - p.value / 10000)) < a.avg_cost,
    giftHeavy: !!(b && mB && mB.sellableStock > 0 && rewardUsed > mB.sellableStock * 0.3),
    // expired goods can never be handed out as a gift: only sellable stock counts
    rewardShort: !!(b && mB && mB.sellableStock - mB.velocity * p.days < rewardUsed),
  };
  const c = cur(ctx);
  const m = (v: number) => formatMoney(v, c);
  const warnings: string[] = [];
  if (flags.loss) warnings.push(`⚠️ هذا العرض يسبب خسارة ${m(-profitAfter)} في كل مرة يُستخدم فيها.`);
  else if (flags.lowMargin) warnings.push(`⚠️ هذا العرض يخفض هامش الربح إلى ${marginAfterPct!.toFixed(1)}% (الحد الأدنى المسموح ${minMargin}%).`);
  if (flags.overDiscount) warnings.push(`⚠️ قيمة الخصم ${effectiveDiscountPct.toFixed(0)}% أكبر من الحد المسموح للعروض (${maxDisc}%).`);
  if (flags.belowCost) warnings.push('⚠️ سعر البيع بعد الخصم أقل من تكلفة المنتج.');
  if (flags.giftHeavy && b) warnings.push(`⚠️ تصريف الكمية المستهدفة سيستخدم ${q(rewardUsed)} من مخزون "${b.name}" كهدايا — تم تحديد عرض واحد لكل فاتورة.`);
  if (flags.rewardShort && b) warnings.push(`⚠️ مخزون "${b.name}" قد لا يكفي للبيع العادي وللعرض معًا خلال مدة العرض — راجع طلب الشراء.`);
  return {
    dealRevenueFull, dealCost, profitBefore, discount, profitAfter, revenueAfter, marginBeforePct, marginAfterPct, effectiveDiscountPct,
    targetQty: target, deals, promoCostTotal: deals * discount, projectedProfit: deals * profitAfter, capitalFreed: mA ? Math.round((Math.min(target, Math.max(mA.stock, 0)) * a.avg_cost) / 1000) : 0,
    rewardUsed, flags, unsafe: flags.loss || flags.lowMargin || flags.overDiscount || flags.belowCost, warnings,
  };
}

function titleOf(p: Proposal, aName: string, bName?: string, money?: (v: number) => string): string {
  const n = q(p.minQty);
  if (p.type === 'percent') return p.minQty > 1000 ? `اشترِ ${n} من ${aName} واحصل على خصم ${p.value / 100}%` : `خصم ${p.value / 100}% على ${aName}`;
  if (p.type === 'cross') return p.rewardType === 'percent'
    ? `اشترِ ${n} من ${aName} واحصل على خصم ${p.value / 100}% على ${bName}`
    : `اشترِ ${n} من ${aName} واحصل على ${q(p.rewardQty ?? 0)} ${bName} مجانًا`;
  return `${aName} + ${bName} بسعر ${money ? money(p.value) : p.value}`;
}

interface Built {
  kind: SuggestionKind; productId: number; partnerId: number | null; score: number; verdict: 'good' | 'ok' | 'review';
  payload: { title: string; proposal: Proposal; simulation: Simulation; reasons: string[]; goal: string; verdictText: string; rejected: { title: string; why: string }[]; history?: string | null; supplierReturn?: { id: number; name: string } | null };
}

/* ------------------------------------------------------------------ feedback loop (rules, not ML) */

export function kindStats(ctx: Ctx): Record<string, { count: number; unitsUpliftPct: number | null; gpChangePct: number | null }> {
  const rows = ctx.db.prepare(
    `SELECT s.kind, p.id FROM promotion_suggestions s JOIN promotions p ON p.id = s.promotion_id WHERE s.status = 'approved' AND p.end_date IS NOT NULL AND p.end_date < ?`,
  ).all(today(ctx)) as { kind: string; id: number }[];
  const acc: Record<string, { n: number; u: number[]; g: number[] }> = {};
  for (const r of rows) {
    const res = promotionPerformance(ctx, r.id, { skipPerm: true });
    if (!res) continue;
    acc[r.kind] ??= { n: 0, u: [], g: [] };
    acc[r.kind].n++;
    if (res.unitsUpliftPct !== null) acc[r.kind].u.push(res.unitsUpliftPct);
    if (res.gpChangePct !== null) acc[r.kind].g.push(res.gpChangePct);
  }
  const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { count: v.n, unitsUpliftPct: avg(v.u), gpChangePct: avg(v.g) }]));
}

/* ------------------------------------------------------------------ generation */

export function buildSuggestions(ctx: Ctx): Built[] {
  const db = ctx.db;
  const metricsList = productMetrics(ctx);
  const metrics = new Map(metricsList.map((m) => [m.id, m]));
  const c = cur(ctx);
  const money = (v: number) => formatMoney(v, c);
  const maxDisc = getSetting(db, 'intel.maxDiscountPct');
  const stats = kindStats(ctx);
  const historyLine = (kind: string) => {
    const s = stats[kind];
    if (!s || s.count < 2 || s.unitsUpliftPct === null) return null;
    return `العروض السابقة من هذا النوع (${s.count}) رفعت المبيعات ${s.unitsUpliftPct.toFixed(0)}% وغيّرت الربح ${s.gpChangePct !== null ? `${s.gpChangePct.toFixed(0)}%` : '—'}.`;
  };
  const historyPenalty = (kind: string) => { const s = stats[kind]; return s && s.count >= 2 && s.gpChangePct !== null && s.gpChangePct < -20 ? 15 : 0; };
  const built: Built[] = [];
  // Feedback loop per product: an offer that ended in the last 60 days without a clear result is not
  // proposed again yet (a dead product would otherwise get the same failed offer every month).
  // Expiry offers are exempt: they prevent waste, not chase sales.
  const t = today(ctx);
  const cooldown = new Set<number>();
  for (const r of db.prepare(`SELECT id, product_id FROM promotions WHERE product_id IS NOT NULL AND end_date IS NOT NULL AND end_date < @t AND end_date >= @from`).all({ t, from: addDays(t, -60) }) as { id: number; product_id: number }[]) {
    const perf = promotionPerformance(ctx, r.id, { skipPerm: true }) as { verdict?: string } | null;
    if (perf?.verdict === 'weak') cooldown.add(r.product_id);
  }
  const maxStockValue = Math.max(1, ...metricsList.map((m) => m.stockValue));
  const pairs = basketPairs(ctx);
  const assoc = (a: number, b: number) => pairs.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  const unitStep = (m: ProductMetrics) => (m.allowDecimal ? 1000 : 1000);

  // fast movers that can serve as a reward
  const hot = metricsList.filter((m) => m.classes.includes('hot') && !m.allowDecimal && m.sellableStock > 0 && m.avgCost > 0 && (m.marginPct ?? 0) > 0
    && !(m.expiry && m.expiry.expiredQty > 0 && m.sellableStock < m.velocity * 7));
  /** offers must end by the last day the goods can legally be sold (latest valid batch expiry) */
  const daysUntil = (d: string) => Math.round((Date.parse(`${d}T00:00:00`) - Date.parse(`${today(ctx)}T00:00:00`)) / 86_400_000);
  const maxOfferDays = (...ms: (ProductMetrics | undefined)[]) => Math.min(...ms.map((m) => (m?.sellUntil ? daysUntil(m.sellUntil) + 1 : 365)));

  for (const a of metricsList) {
    if (a.avgCost <= 0 || a.price <= 0 || a.stock <= 0) continue; // no cost -> cannot judge profitability honestly
    const isClear = a.classes.some((x) => x === 'dead' || x === 'excess' || x === 'slow');
    const isExpiry = a.classes.includes('expiry') && a.expiry && a.expiry.atRiskQty > 0;

    /* ---------------- expiry: discount to sell before it expires */
    if (isExpiry) {
      const e = a.expiry!;
      const lossIfExpired = Math.round((e.atRiskQty * a.avgCost) / 1000);
      // too small to be worth an offer (e.g. one loaf of bread): the expiry alert is enough
      if (lossIfExpired < MIN_EXPIRY_VALUE) continue;
      // the offer must end before the goods expire (never run an offer on expired stock)
      const days = Math.max(1, Math.min(e.daysLeft, 21));
      const maxPct = e.daysLeft <= 7 ? 30 : e.daysLeft <= 14 ? 20 : e.daysLeft <= 30 ? 15 : 10;
      // prefer the deepest discount that still sells above cost; only if none exists, propose the
      // urgency discount and mark it for review (a smaller loss than throwing the goods away)
      let pick: { proposal: Proposal; sim: Simulation } | null = null;
      let urgent: { proposal: Proposal; sim: Simulation } | null = null;
      for (const pct of [30, 20, 15, 10, 5].filter((x) => x <= maxPct)) {
        const proposal: Proposal = { type: 'percent', productId: a.id, minQty: a.allowDecimal ? 1 : 1000, value: pct * 100, days, name: `تصريف قبل الصلاحية — ${a.name}` };
        const sim = simulate(ctx, proposal, metrics, e.atRiskQty);
        if (!urgent) urgent = { proposal, sim };
        if (!sim.unsafe) { pick = { proposal, sim }; break; }
      }
      const { proposal, sim } = pick ?? urgent!;
      const reasons = [...a.reasons, `قيمة الكمية المعرضة للتلف بالتكلفة: ${money(lossIfExpired)}.`];
      if (sim.flags.belowCost || sim.flags.loss) reasons.push(`البيع بالخصم أقل من التكلفة، لكن الخسارة المتوقعة (${money(Math.max(0, -sim.projectedProfit))}) أقل من خسارة التلف الكامل (${money(lossIfExpired)}).`);
      else if (pick && proposal.value / 100 < maxPct) reasons.push(`تم اختيار خصم ${proposal.value / 100}% لأنه أكبر خصم يظل فوق التكلفة.`);
      // the batch's supplier may take it back — suggested as an alternative, never done automatically
      const sup = db.prepare(
        `SELECT s.id, s.name FROM batches b LEFT JOIN purchases pu ON b.ref_type = 'purchase' AND pu.id = b.ref_id JOIN suppliers s ON s.id = COALESCE(b.supplier_id, pu.supplier_id)
         WHERE b.product_id = ? AND b.qty > 0 AND b.expiry_date = ? LIMIT 1`,
      ).get(a.id, e.nearestDate) as { id: number; name: string } | undefined;
      if (sup) reasons.push(`بديل: راجع إرجاع الكمية للمورد «${sup.name}» من شاشة الصلاحية بدل الخصم، إذا كان يقبل المرتجع.`);
      built.push({
        kind: 'expiry', productId: a.id, partnerId: null, verdict: sim.unsafe ? 'review' : 'good',
        // loss-making offers rank below safe ones; urgency and value at risk order the rest
        score: 60 + 30 * (1 - Math.min(Math.max(e.daysLeft, 0), 60) / 60) + 10 * (lossIfExpired / maxStockValue) - (sim.unsafe ? REVIEW_PENALTY : 0),
        payload: { title: titleOf(proposal, a.name), proposal, simulation: sim, reasons, goal: `بيع ${q(e.atRiskQty)} ${a.unitSymbol} قبل ${arDate(e.nearestDate)} بدل خسارتها.`, verdictText: sim.unsafe ? VERDICT_TEXT.review : VERDICT_TEXT.good, rejected: [], history: historyLine('expiry'), supplierReturn: sup ?? null },
      });
      continue;
    }

    if (cooldown.has(a.id)) continue;
    if (a.sellableStock <= 0) continue; // only expired stock left: that is for disposal / supplier return, not an offer

    /* ---------------- slow / dead / excess: clear stock, protect margin */
    if (isClear && (a.marginPct ?? 0) > 0) {
      const rawTarget = a.classes.includes('dead') ? a.sellableStock : Math.max(0, a.sellableStock - a.velocity * 30);
      const target = a.allowDecimal ? Math.round(rawTarget) : Math.floor(rawTarget / 1000) * 1000;
      if (target < unitStep(a)) continue;
      // best partner among fast movers: bought-together > same category > sensible gift price
      const partners = hot.filter((b) => b.id !== a.id).map((b) => {
        const as = assoc(a.id, b.id);
        const giftShare = b.price / Math.max(1, a.price * 2);
        const s = (as ? 40 * Math.min(as.lift, 3) : 0) + (b.categoryId && b.categoryId === a.categoryId ? 15 : 0) + (giftShare <= 0.6 ? 20 - Math.abs(0.35 - giftShare) * 30 : -50) + Math.min(b.velocity / 1000, 20);
        return { b, s, as };
      }).filter((x) => x.s > -20).sort((x, y) => y.s - x.s);
      const partner = partners.find((x) => maxOfferDays(a, x.b) >= 7);
      const options: Proposal[] = [];
      const days = Math.min(21, maxOfferDays(a, partner?.b));
      if (days < 3) continue; // too close to expiry for a sales offer — the expiry suggestion covers it
      if (partner && !a.allowDecimal) {
        const B = partner.b;
        for (const n of [2, 3]) options.push({ type: 'cross', productId: a.id, rewardProductId: B.id, minQty: n * 1000, rewardQty: 1000, rewardType: 'free', value: 0, maxPerInvoice: 2, days, name: '' });
        for (const pct of [50, 25, 15, 10]) options.push({ type: 'cross', productId: a.id, rewardProductId: B.id, minQty: 2000, rewardQty: 1000, rewardType: 'percent', value: pct * 100, maxPerInvoice: 2, days, name: '' });
      }
      for (const n of a.allowDecimal ? [1] : [2, 3]) for (const pct of [15, 10, 5]) options.push({ type: 'percent', productId: a.id, minQty: n * 1000, value: pct * 100, days, name: '' });
      const rejected: { title: string; why: string }[] = [];
      let chosen: { p: Proposal; sim: Simulation } | null = null;
      let leastBad: { p: Proposal; sim: Simulation } | null = null;
      for (const p of options) {
        if (p.type === 'percent' && p.value / 100 > maxDisc) continue;
        const sim = simulate(ctx, p, metrics, target);
        const bName = p.rewardProductId ? metrics.get(p.rewardProductId)?.name : undefined;
        if (!sim.unsafe && !sim.flags.rewardShort) { chosen = { p, sim }; break; }
        if (!leastBad || sim.profitAfter > leastBad.sim.profitAfter) leastBad = { p, sim };
        if (rejected.length < 2 && (p.type === 'cross')) rejected.push({ title: titleOf(p, a.name, bName, money), why: sim.warnings[0] ?? 'لا يحقق قواعد الربحية' });
      }
      const pick = chosen ?? leastBad;
      if (!pick) continue;
      const B = pick.p.rewardProductId ? metrics.get(pick.p.rewardProductId) : undefined;
      pick.p.name = titleOf(pick.p, a.name, B?.name, money);
      if (pick.sim.flags.giftHeavy) pick.p.maxPerInvoice = 1;
      const reasons = [...a.reasons, `لديك ${q(a.stock)} ${a.unitSymbol} من ${a.name}${a.velocity > 0 ? ` ومتوسط البيع ${q(a.velocity)} يوميًا` : ''}.`];
      if (a.daysCover && a.velocity > 0) reasons.push(`المخزون الحالي يكفي تقريبًا ${Math.round(a.daysCover)} يوم.`);
      if (B) {
        reasons.push(`"${B.name}" من الأكثر طلبًا: متوسط ${q(B.velocity)} يوميًا — مناسب كحافز للعميل.`);
        if (partner?.as) reasons.push(`${Math.round(partner.as.confAB * 100)}% من فواتير ${a.name} فيها ${B.name} أيضًا (من ${partner.as.both} فاتورة).`);
      }
      const verdict: 'good' | 'ok' | 'review' = chosen ? (a.classes.includes('dead') || a.classes.includes('excess') ? 'good' : 'ok') : 'review';
      const kind: SuggestionKind = pick.p.type === 'cross' ? 'pair' : pick.p.minQty > 1000 ? 'quantity' : 'clearance';
      built.push({
        kind, productId: a.id, partnerId: B?.id ?? null, verdict,
        score: 40 * (a.stockValue / maxStockValue) + 25 * Math.min(1, (a.daysSinceLast ?? a.ageDays) / 90)
          + 20 * Math.min(1, a.daysCover ? a.daysCover / 180 : 1) + 15 * Math.min(1, Math.max(0, (pick.sim.marginAfterPct ?? 0) / 30))
          + (partner?.as ? 10 : 0) - (verdict === 'review' ? 20 : 0) - historyPenalty(kind),
        payload: {
          title: pick.p.name, proposal: pick.p, simulation: pick.sim, reasons, rejected, history: historyLine(kind),
          goal: `تصريف حوالي ${q(pick.sim.targetQty)} ${a.unitSymbol} من ${a.name} وتحرير حوالي ${money(pick.sim.capitalFreed)} من رأس المال.`,
          verdictText: VERDICT_TEXT[verdict],
        },
      });
    }
  }

  /* ---------------- bundles from real basket data */
  if (pairs.sufficient) {
    for (const pr of pairs.pairs.slice(0, 15)) {
      const A = metrics.get(pr.a);
      const B = metrics.get(pr.b);
      if (!A || !B || A.allowDecimal || B.allowDecimal || A.avgCost <= 0 || B.avgCost <= 0) continue;
      if (pr.lift < 1.5 || Math.max(pr.confAB, pr.confBA) < 0.2) continue;
      if (built.some((x) => x.productId === A.id || x.productId === B.id)) continue;
      if (A.sellableStock <= 0 || B.sellableStock <= 0) continue;
      const bundleDays = Math.min(30, maxOfferDays(A, B));
      if (bundleDays < 7) continue;
      let pick: { p: Proposal; sim: Simulation } | null = null;
      for (const d of [10, 7, 5]) {
        const price = Math.floor(((A.price + B.price) * (1 - d / 100)) / 50) * 50; // round down to half a pound
        const p: Proposal = { type: 'combo', productId: A.id, rewardProductId: B.id, minQty: 1000, rewardQty: 1000, value: price, days: bundleDays, name: '' };
        const sim = simulate(ctx, p, metrics, A.velocity * 30);
        if (!sim.unsafe) { pick = { p, sim }; break; }
      }
      if (!pick) continue;
      pick.p.name = titleOf(pick.p, A.name, B.name, money);
      built.push({
        kind: 'bundle', productId: A.id, partnerId: B.id, verdict: 'ok', score: 30 + 20 * Math.min(1, pr.lift / 3) + 10 * Math.max(pr.confAB, pr.confBA),
        payload: {
          title: pick.p.name, proposal: pick.p, simulation: pick.sim, rejected: [], history: historyLine('bundle'),
          reasons: [`${Math.round(pr.confAB * 100)}% من العملاء الذين يشترون ${A.name} يشترون ${B.name} أيضًا (${pr.both} فاتورة من ${pairs.invoices}).`, `احتمال شرائهما معًا ${pr.lift.toFixed(1)} ضعف الصدفة.`],
          goal: 'زيادة متوسط قيمة الفاتورة بعرض على منتجين يُشتريان معًا فعلًا.', verdictText: VERDICT_TEXT.ok,
        },
      });
    }
  }
  return built.sort((x, y) => y.score - x.score);
}

/** Generate (or refresh) this month's suggestions. Decided ones are kept; rejected/muted are respected. */
export function generateSuggestions(ctx: Ctx) {
  requirePerm(ctx, 'reports.view');
  const per = period(ctx);
  const built = buildSuggestions(ctx);
  return tx(ctx, () => {
    ctx.db.prepare(`DELETE FROM promotion_suggestions WHERE period = ? AND status = 'new'`).run(per);
    const decided = ctx.db.prepare(`SELECT product_id, kind FROM promotion_suggestions WHERE period = ? AND status <> 'new'`).all(per) as { product_id: number; kind: string }[];
    const mutes = ctx.db.prepare('SELECT product_id, kind FROM suggestion_mutes').all() as { product_id: number | null; kind: string | null }[];
    const promoted = new Set((ctx.db.prepare(
      `SELECT product_id AS id FROM promotions WHERE active = 1 AND (end_date IS NULL OR end_date >= @d) AND product_id IS NOT NULL
       UNION SELECT reward_product_id FROM promotions WHERE active = 1 AND (end_date IS NULL OR end_date >= @d) AND reward_product_id IS NOT NULL`,
    ).all({ d: today(ctx) }) as { id: number }[]).map((r) => r.id));
    const ins = ctx.db.prepare(
      `INSERT INTO promotion_suggestions(period, kind, status, product_id, partner_product_id, score, verdict, payload, generated_at) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    for (const s of built) {
      const muted = mutes.some((m) => (m.product_id === null || m.product_id === s.productId) && (m.kind === null || m.kind === s.kind) && (m.product_id !== null || m.kind !== null));
      if (muted) continue;
      // once the owner decided on a product this month, don't nag about it again until next month
      if (decided.some((d) => d.product_id === s.productId)) continue;
      if (promoted.has(s.productId) || (s.partnerId && promoted.has(s.partnerId))) continue;
      ins.run(per, s.kind, s.productId, s.partnerId, Math.round(s.score * 100) / 100, s.verdict, JSON.stringify(s.payload), ts(ctx));
      n++;
    }
    ctx.db.prepare(`INSERT INTO app_meta(key, value) VALUES ('intel_last_gen', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(ts(ctx));
    return { generated: n, period: per };
  });
}

function ensureFresh(ctx: Ctx) {
  const last = (ctx.db.prepare(`SELECT value FROM app_meta WHERE key = 'intel_last_gen'`).get() as { value: string } | undefined)?.value;
  const stale = !last || last.slice(0, 7) !== period(ctx) || Date.parse(ts(ctx)) - Date.parse(last) > 24 * 3600_000;
  if (stale) generateSuggestions(ctx);
}

export function listSuggestions(ctx: Ctx, opts: { status?: string; all?: boolean } = {}) {
  requirePerm(ctx, 'reports.view');
  if (!can(ctx, 'reports.cost')) return { items: [], limited: true };
  ensureFresh(ctx);
  const rows = ctx.db.prepare(
    `SELECT s.*, p.name AS product_name, pp.name AS partner_name, u.full_name AS decided_by_name FROM promotion_suggestions s
     JOIN products p ON p.id = s.product_id LEFT JOIN products pp ON pp.id = s.partner_product_id LEFT JOIN users u ON u.id = s.decided_by
     WHERE s.period = @p ${opts.status ? 'AND s.status = @st' : ''} ORDER BY CASE s.status WHEN 'new' THEN 0 ELSE 1 END, s.score DESC`,
  ).all({ p: period(ctx), st: opts.status ?? null }) as any[];
  const max = getSetting(ctx.db, 'intel.maxSuggestions');
  const items = rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  if (opts.all) return { items, total: items.length, limited: false };
  // The short list must not be monopolised by one kind (a dairy-heavy store would otherwise only
  // ever see expiry offers and never its dead stock): each kind gets at most half of the new slots.
  const decided = items.filter((i) => i.status !== 'new');
  const fresh = items.filter((i) => i.status === 'new');
  const cap = Math.max(1, Math.ceil(max / 2));
  const perKind = new Map<string, number>();
  const shown: any[] = [];
  for (const it of fresh) {
    if (shown.length >= max) break;
    if ((perKind.get(it.kind) ?? 0) >= cap) continue;
    perKind.set(it.kind, (perKind.get(it.kind) ?? 0) + 1);
    shown.push(it);
  }
  for (const it of fresh) { if (shown.length >= max) break; if (!shown.includes(it)) shown.push(it); }
  return { items: [...shown, ...decided], total: items.length, limited: false };
}

/** Re-simulate an edited proposal (owner adjusting the offer before approval). */
export function simulateProposal(ctx: Ctx, p: Proposal) {
  requirePerm(ctx, 'reports.cost');
  const metrics = new Map(productMetrics(ctx).map((m) => [m.id, m]));
  const sim = simulate(ctx, sanitize(p), metrics);
  return sim;
}

function sanitize(p: Proposal): Proposal {
  const int = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
  const type = (['percent', 'cross', 'combo'] as const).includes(p.type) ? p.type : 'percent';
  return {
    type, productId: int(p.productId, 1, Number.MAX_SAFE_INTEGER), rewardProductId: p.rewardProductId ? int(p.rewardProductId, 1, Number.MAX_SAFE_INTEGER) : null,
    minQty: int(p.minQty, 1, 1_000_000), rewardQty: int(p.rewardQty ?? 0, 0, 1_000_000), rewardType: p.rewardType === 'percent' ? 'percent' : type === 'cross' ? 'free' : null,
    value: int(p.value, 0, type === 'combo' ? 1_000_000_000 : 10_000), maxPerInvoice: p.maxPerInvoice ? int(p.maxPerInvoice, 1, 100) : null, days: int(p.days, 1, 365), name: String(p.name ?? '').slice(0, 200),
  };
}

function snapshot(m: ProductMetrics | undefined) {
  if (!m) return null;
  return { stock: m.stock, velocity: m.velocity, revenuePerDay: m.revenue / m.effWindow, profitPerDay: m.profit / m.effWindow, avgCost: m.avgCost, price: m.price };
}

/** Owner approves (optionally edited). Creates and activates the promotion; the decision is audited. */
export function approveSuggestion(ctx: Ctx, input: { id: number; proposal?: Partial<Proposal>; startDate?: string | null; endDate?: string | null; name?: string | null }) {
  requirePerm(ctx, 'promotions.approve');
  return tx(ctx, () => {
    const s = ctx.db.prepare('SELECT * FROM promotion_suggestions WHERE id = ?').get(input.id) as any;
    if (!s) throw new AppError('NOT_FOUND');
    if (s.status !== 'new') throw new AppError('SUGGESTION_CLOSED');
    const payload = JSON.parse(s.payload) as Built['payload'];
    const p = sanitize({ ...payload.proposal, ...(input.proposal ?? {}), productId: payload.proposal.productId, rewardProductId: payload.proposal.rewardProductId });
    const metrics = new Map(productMetrics(ctx).map((m) => [m.id, m]));
    const sim = simulate(ctx, p, metrics);
    let approvedBy: number | null = null;
    // the safety rules are enforced here, server-side: an unsafe offer needs explicit override permission
    if (sim.unsafe && s.kind !== 'expiry') approvedBy = requirePermOrApproval(ctx, 'promotions.override');
    if (sim.unsafe && s.kind === 'expiry' && (sim.flags.loss || sim.flags.belowCost)) approvedBy = requirePermOrApproval(ctx, 'promotions.override');
    const start = input.startDate || today(ctx);
    const end = input.endDate || addDays(start, p.days - 1);
    for (const pid of [p.productId, p.rewardProductId]) {
      const until = pid ? metrics.get(pid)?.sellUntil : null;
      if (until && end > until) throw new AppError('PROMO_PAST_EXPIRY', { date: until });
    }
    const name = (input.name || p.name || payload.title).slice(0, 200);
    const baseline = { at: today(ctx), a: snapshot(metrics.get(p.productId)), b: p.rewardProductId ? snapshot(metrics.get(p.rewardProductId)) : null, simulation: sim };
    const info = ctx.db.prepare(
      `INSERT INTO promotions(name, type, product_id, min_qty, get_qty, value, reward_product_id, reward_qty, reward_type, max_per_invoice, start_date, end_date, active, suggestion_id, reason, baseline, created_by, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(name, p.type, p.productId, p.minQty, p.value, p.rewardProductId ?? null, p.rewardQty ?? 0, p.type === 'cross' ? p.rewardType : null, p.maxPerInvoice ?? null,
      start, end, s.id, payload.reasons.join(' '), JSON.stringify(baseline), ctx.user?.id ?? null, ts(ctx));
    const promoId = Number(info.lastInsertRowid);
    if (!getSetting(ctx.db, 'features.promotions')) setSettingRaw(ctx.db, 'features.promotions', true);
    ctx.db.prepare(`UPDATE promotion_suggestions SET status = 'approved', decided_by = ?, decided_at = ?, promotion_id = ? WHERE id = ?`).run(ctx.user?.id ?? null, ts(ctx), promoId, s.id);
    audit(ctx, 'promotion.approve_suggestion', 'promotion', promoId, { suggestion: s.id }, { name, type: p.type, start, end, unsafe: sim.unsafe, profitAfter: sim.profitAfter }, null, approvedBy);
    return { promotionId: promoId, simulation: sim };
  });
}

export function rejectSuggestion(ctx: Ctx, input: { id: number; note?: string | null; muteProduct?: boolean; muteKind?: boolean }) {
  requirePerm(ctx, 'promotions.approve');
  return tx(ctx, () => {
    const s = ctx.db.prepare('SELECT * FROM promotion_suggestions WHERE id = ?').get(input.id) as any;
    if (!s) throw new AppError('NOT_FOUND');
    if (s.status !== 'new') throw new AppError('SUGGESTION_CLOSED');
    ctx.db.prepare(`UPDATE promotion_suggestions SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`)
      .run(input.muteProduct || input.muteKind ? 'dismissed' : 'rejected', ctx.user?.id ?? null, ts(ctx), input.note ?? null, s.id);
    if (input.muteProduct) ctx.db.prepare('INSERT INTO suggestion_mutes(product_id, kind, created_by, created_at) VALUES (?, NULL, ?, ?)').run(s.product_id, ctx.user?.id ?? null, ts(ctx));
    if (input.muteKind) ctx.db.prepare('INSERT INTO suggestion_mutes(product_id, kind, created_by, created_at) VALUES (NULL, ?, ?, ?)').run(s.kind, ctx.user?.id ?? null, ts(ctx));
    audit(ctx, 'promotion.reject_suggestion', 'promotion_suggestion', s.id, undefined, { muteProduct: !!input.muteProduct, muteKind: !!input.muteKind }, input.note);
    return { ok: true };
  });
}

export function listMutes(ctx: Ctx) {
  requirePerm(ctx, 'reports.view');
  return ctx.db.prepare(`SELECT m.*, p.name AS product_name FROM suggestion_mutes m LEFT JOIN products p ON p.id = m.product_id ORDER BY m.id DESC`).all();
}

export function removeMute(ctx: Ctx, id: number) {
  requirePerm(ctx, 'promotions.approve');
  ctx.db.prepare('DELETE FROM suggestion_mutes WHERE id = ?').run(id);
  return { ok: true };
}

/* ------------------------------------------------------------------ measuring results */

interface Window { units: number; revenue: number; cost: number; profit: number; invoices: number }

function productWindow(ctx: Ctx, productId: number, from: string, to: string): Window {
  const s = ctx.db.prepare(
    `SELECT COALESCE(SUM(si.base_qty),0) AS q, COALESCE(SUM(si.net_revenue),0) AS rev, COALESCE(SUM(si.cost_total),0) AS cost, COUNT(DISTINCT si.sale_id) AS inv
     FROM sale_items si JOIN sales sa ON sa.id = si.sale_id WHERE si.product_id = ? AND sa.status = 'completed' AND sa.business_date BETWEEN ? AND ?`,
  ).get(productId, from, to) as { q: number; rev: number; cost: number; inv: number };
  const r = ctx.db.prepare(
    `SELECT COALESCE(SUM(ri.base_qty),0) AS q, COALESCE(SUM(ri.net_revenue),0) AS rev, COALESCE(SUM(ri.cost_total),0) AS cost
     FROM sale_return_items ri JOIN sale_returns rt ON rt.id = ri.return_id WHERE ri.product_id = ? AND rt.business_date BETWEEN ? AND ?`,
  ).get(productId, from, to) as { q: number; rev: number; cost: number };
  const revenue = s.rev - r.rev;
  const cost = s.cost - r.cost;
  return { units: s.q - r.q, revenue, cost, profit: revenue - cost, invoices: s.inv };
}

function stockAt(ctx: Ctx, productId: number, date: string): number {
  const now = (ctx.db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM product_stock WHERE product_id = ?').get(productId) as { q: number }).q;
  const after = (ctx.db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE product_id = ? AND business_date >= ?').get(productId, date) as { q: number }).q;
  return now - after;
}

/**
 * Compares the promotion period with an equally long period just before it.
 * Success is judged on units, revenue, gross profit, margin AND stock
 * reduction — never on sales alone.
 */
export function promotionPerformance(ctx: Ctx, promotionId: number, opts: { skipPerm?: boolean } = {}) {
  if (!opts.skipPerm) requirePerm(ctx, 'reports.cost');
  const p = ctx.db.prepare(`SELECT pr.*, a.name AS product_name, b.name AS reward_name FROM promotions pr LEFT JOIN products a ON a.id = pr.product_id LEFT JOIN products b ON b.id = pr.reward_product_id WHERE pr.id = ?`).get(promotionId) as any;
  if (!p || !p.product_id) return null;
  const start = p.start_date ?? p.created_at.slice(0, 10);
  const t = today(ctx);
  if (start > t) return { promotion: p, status: 'scheduled' as const, unitsUpliftPct: null, gpChangePct: null };
  const end = p.end_date && p.end_date < t ? p.end_date : t;
  const len = Math.max(1, Math.round((Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`)) / 86_400_000) + 1);
  const bFrom = addDays(start, -len);
  const bTo = addDays(start, -1);
  const ids = [p.product_id, ...(p.reward_product_id ? [p.reward_product_id] : [])];
  const sum = (ws: Window[]) => ws.reduce((a, w) => ({ units: a.units + w.units, revenue: a.revenue + w.revenue, cost: a.cost + w.cost, profit: a.profit + w.profit, invoices: a.invoices + w.invoices }), { units: 0, revenue: 0, cost: 0, profit: 0, invoices: 0 });
  const before = sum(ids.map((id) => productWindow(ctx, id, bFrom, bTo)));
  const during = sum(ids.map((id) => productWindow(ctx, id, start, end)));
  const mainBefore = productWindow(ctx, p.product_id, bFrom, bTo);
  const mainDuring = productWindow(ctx, p.product_id, start, end);
  const usage = ctx.db.prepare(`SELECT COUNT(DISTINCT si.sale_id) AS uses, COALESCE(SUM(si.promo_discount),0) AS discount FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.promotion_id = ? AND s.status = 'completed'`).get(promotionId) as { uses: number; discount: number };
  const stockStart = stockAt(ctx, p.product_id, start);
  const stockNow = stockAt(ctx, p.product_id, addDays(end, 1));
  const pct = (a: number, b: number) => (b !== 0 ? ((a - b) / Math.abs(b)) * 100 : a > 0 ? 100 : null);
  const unitsUpliftPct = pct(mainDuring.units, mainBefore.units);
  const gpChangePct = pct(during.profit, before.profit);
  const stockReductionPct = stockStart > 0 ? ((stockStart - stockNow) / stockStart) * 100 : null;
  const marginBefore = before.revenue > 0 ? (before.profit / before.revenue) * 100 : null;
  const marginDuring = during.revenue > 0 ? (during.profit / during.revenue) * 100 : null;
  let verdict: 'success' | 'mixed' | 'clearance' | 'weak' = 'weak';
  let text = 'لم يحقق العرض تحسنًا واضحًا حتى الآن.';
  const unitsUp = mainDuring.units > mainBefore.units * 1.2;
  if (unitsUp && during.profit >= before.profit) { verdict = 'success'; text = '✅ نجح العرض: زادت الكمية المباعة وزاد الربح.'; }
  else if (unitsUp && during.profit < before.profit) { verdict = 'mixed'; text = '⚠️ زادت المبيعات لكن الربح انخفض — راجع قيمة الخصم.'; }
  else if ((stockReductionPct ?? 0) >= 30 && during.profit >= 0) { verdict = 'clearance'; text = '✅ ساعد العرض في تصريف المخزون دون خسارة.'; }
  return {
    promotion: p, status: p.end_date && p.end_date < t ? ('finished' as const) : ('running' as const), start, end, days: len,
    before, during, mainBefore, mainDuring, uses: usage.uses, discountGiven: usage.discount, stockStart, stockNow,
    unitsUpliftPct, gpChangePct, stockReductionPct, marginBefore, marginDuring, verdict, text,
  };
}

export function promotionResults(ctx: Ctx) {
  requirePerm(ctx, 'reports.cost');
  const rows = ctx.db.prepare(`SELECT id FROM promotions WHERE product_id IS NOT NULL ORDER BY id DESC LIMIT 100`).all() as { id: number }[];
  return rows.map((r) => promotionPerformance(ctx, r.id)).filter(Boolean);
}

/* ------------------------------------------------------------------ monthly business review */

/** "ماذا يحتاج المحل هذا الشهر؟" — 3 to 5 highest-value items only. */
export function monthlyFocus(ctx: Ctx) {
  requirePerm(ctx, 'reports.view');
  const c = cur(ctx);
  const money = (v: number) => formatMoney(v, c);
  const metrics = productMetrics(ctx);
  const items: { key: string; icon: string; title: string; text: string; link: string; weight: number }[] = [];
  const showCost = can(ctx, 'reports.cost');
  const stuck = metrics.filter((m) => m.classes.some((x) => x === 'dead' || x === 'excess' || x === 'slow') && m.stock > 0);
  if (stuck.length) {
    const capital = stuck.reduce((a, m) => a + m.stockValue, 0);
    items.push({ key: 'stuck', icon: '⚠️', title: 'مخزون راكد أو بطيء', text: showCost ? `${stuck.length} منتج يحتاج تصريف — رأس مال محبوس ${money(capital)}.` : `${stuck.length} منتج يحتاج تصريف.`, link: '/insights?tab=slow', weight: 90 });
  }
  const hot = metrics.filter((m) => m.classes.includes('hot')).sort((a, b) => b.velocity - a.velocity);
  if (hot.length) items.push({ key: 'hot', icon: '🔥', title: 'طلب مرتفع', text: `${hot.length} منتج عليه سحب قوي، أعلاها: ${hot.slice(0, 2).map((h) => h.name).join('، ')}.`, link: '/insights?tab=demand', weight: 60 });
  if (showCost) {
    try {
      const sug = listSuggestions(ctx).items.filter((s: any) => s.status === 'new');
      if (sug.length) items.push({ key: 'promo', icon: '💡', title: 'عرض مقترح', text: sug[0].payload.title, link: '/insights?tab=promos', weight: 80 });
    } catch { /* suggestions are optional */ }
  }
  if (can(ctx, 'inventory.view')) {
    const re = reorderSuggestions(ctx, {});
    const first = re.find((r) => r.urgency === 'high') ?? re[0];
    if (first) items.push({ key: 'reorder', icon: '📦', title: 'طلب مقترح', text: `إعادة طلب ${first.purchaseUnits} ${first.purchaseUnit} من ${first.name}${re.length > 1 ? ` (+${re.length - 1} منتج آخر)` : ''}.`, link: '/inventory/low', weight: first.urgency === 'high' ? 85 : 55 });
  }
  const expiring = metrics.filter((m) => m.expiry && m.expiry.daysLeft <= 30);
  if (expiring.length) items.push({ key: 'expiry', icon: '⏳', title: 'صلاحية', text: `${expiring.length} منتج ستنتهي صلاحية جزء منه خلال 30 يومًا.`, link: '/inventory/expiry', weight: 95 });
  return items.sort((a, b) => b.weight - a.weight).slice(0, 5);
}
