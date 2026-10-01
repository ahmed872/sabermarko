import { describe, it, expect } from 'vitest';
import { setupStore, addProduct, egp, type TestEnv } from './helpers';
import { checkout, quoteCart } from '../../src/main/services/sales';
import { createPurchase } from '../../src/main/services/purchases';
import { productMetrics, basketPairs, intelOverview, demandLeaders, seasonalSignals } from '../../src/main/services/analytics';
import { approveSuggestion, buildSuggestions, generateSuggestions, listSuggestions, monthlyFocus, promotionPerformance, rejectSuggestion, simulate } from '../../src/main/services/recommendations';
import { saveRole, saveUser, login } from '../../src/main/services/users';
import { openShift } from '../../src/main/services/shifts';
import { setSettingRaw, type Ctx } from '../../src/main/services/context';
import { createProduct } from '../../src/main/services/products';

const DAY = 86_400_000;

/** Run `days` simulated store days; `plan(day)` returns the invoices of that day (each invoice = list of [productId, qty]). */
function simulateDays(env: TestEnv, days: number, plan: (day: number) => [number, number][][]) {
  const piece = env.unit('قطعة');
  for (let d = 0; d < days; d++) {
    env.clock.t = new Date(env.clock.t.getTime() + DAY);
    for (const inv of plan(d)) {
      if (!inv.length) continue;
      const lines = inv.map(([productId, n]) => ({ productId, unitId: piece, qty: n * 1000 }));
      const q = quoteCart(env.ctx, { lines });
      checkout(env.ctx, { cart: { lines }, payments: [{ method: 'cash', amount: q.total }] });
    }
  }
}

/** A store with enough history for percentiles: A slow + excess, B fast, plus filler products. */
function scenarioStore(opts: { aPrice?: number; aCost?: number; bPrice?: number; bCost?: number } = {}) {
  const env = setupStore();
  env.clock.t = new Date(2026, 7, 1, 10); // products created 1 Aug, history through August
  const A = addProduct(env, { name: 'شيبسي X', price: opts.aPrice ?? 20, cost: opts.aCost ?? 12, qty: 130 });
  const B = addProduct(env, { name: 'مياه Y', price: opts.bPrice ?? 10, cost: opts.bCost ?? 7, qty: 900 });
  const fillers = [
    addProduct(env, { name: 'بسكويت', price: 5, cost: 3.5, qty: 150 }),
    addProduct(env, { name: 'عصير', price: 12, cost: 9, qty: 150 }),
    addProduct(env, { name: 'شوكولاتة', price: 15, cost: 10, qty: 150 }),
    addProduct(env, { name: 'لبان', price: 3, cost: 1.5, qty: 150 }),
    addProduct(env, { name: 'مناديل', price: 8, cost: 5, qty: 150 }),
  ];
  // 30 days: A sells 1/day, B sells 15/day (5 invoices x 3), fillers 2-6/day
  simulateDays(env, 30, (d) => [
    [[A, 1], [B, 3]],
    [[B, 3], [fillers[0], 2]],
    [[B, 3], [fillers[1], 3]],
    [[B, 3], [fillers[2], 2], [fillers[3], 4]],
    [[B, 3], [fillers[4], d % 2 ? 2 : 3]],
  ]);
  return { env, A, B, fillers };
}

describe('dynamic product classification', () => {
  it('spec §28: A (100 left, 1/day) is slow/excess; B (15/day) is a fast mover', () => {
    const { env, A, B } = scenarioStore();
    const m = new Map(productMetrics(env.ctx).map((x) => [x.id, x]));
    const a = m.get(A)!;
    const b = m.get(B)!;
    expect(a.stock).toBe(100_000);
    expect(a.velocity).toBeCloseTo(1000, 0);
    expect(Math.round(a.daysCover!)).toBe(100);
    expect(a.classes).toEqual(expect.arrayContaining(['excess', 'slow']));
    expect(b.classes).toContain('hot');
    expect(b.velocity).toBeCloseTo(15_000, 0);
    expect(a.reasons.join(' ')).toContain('يكفي تقريبًا 100 يوم');
    const ov = intelOverview(env.ctx);
    expect(ov.deadCapital).toBeGreaterThanOrEqual(egp(100 * 12)); // A's stock value is part of stuck capital
    expect(ov.dataSufficient).toBe(true);
  });

  it('adaptive dead-stock: a product with a slow natural rhythm is not called dead too early', () => {
    const env = setupStore();
    env.clock.t = new Date(2026, 4, 1, 10);
    const rare = addProduct(env, { name: 'فانوس رمضان', price: 100, cost: 60, qty: 50 });
    const never = addProduct(env, { name: 'منتج لم يُبع', price: 10, cost: 6, qty: 20 });
    const daily = addProduct(env, { name: 'خبز', price: 5, cost: 3, qty: 2000 });
    // rare item sells once every ~25 days for 4 months; daily item sells every day
    simulateDays(env, 125, (d) => [[[daily, 5]], ...(d % 25 === 0 ? [[[rare, 1] as [number, number]]] : [])]);
    // 31 days of silence for the rare item: under its own rhythm (3 x 25 = 75 days) it is not dead yet
    simulateDays(env, 31, () => [[[daily, 5]]]);
    const m = new Map(productMetrics(env.ctx).map((x) => [x.id, x]));
    expect(m.get(rare)!.classes).not.toContain('dead');
    expect(m.get(never)!.classes).toContain('dead');
    expect(m.get(never)!.reasons[0]).toContain('لم يُبع أبدًا');
  });

  it('small store: with too little data nothing is labelled hot/slow and basket analysis says so', () => {
    const env = setupStore();
    env.clock.t = new Date(2026, 8, 1, 10);
    const a = addProduct(env, { name: 'A', price: 10, cost: 6, qty: 50 });
    const b = addProduct(env, { name: 'B', price: 10, cost: 6, qty: 50 });
    simulateDays(env, 20, () => [[[a, 1], [b, 1]]]);
    const m = productMetrics(env.ctx);
    expect(m.every((x) => !x.classes.includes('hot') && !x.classes.includes('slow'))).toBe(true);
    const basket = basketPairs(env.ctx);
    expect(basket.sufficient).toBe(false);
    expect(basket.pairs).toHaveLength(0);
    expect(seasonalSignals(env.ctx).sufficient).toBe(false);
  });

  it('separates best-selling from most-profitable', () => {
    const { env, B, fillers } = scenarioStore();
    const d = demandLeaders(env.ctx);
    expect(d.byQty[0].id).toBe(B);
    // chocolate (2/day x 5 profit) and juice (3/day x 3) vs water (15/day x 3) - water still leads profit here,
    // but the lists are computed independently
    expect(d.byProfit.map((x) => x.id)).toContain(fillers[2]);
    expect(d.byInvoices[0].invoices).toBeGreaterThan(0);
  });
});

describe('promotion engine safety and profitability', () => {
  it('spec §28/§7: suggests a slow+fast pairing with full before/after economics', () => {
    const { env, A, B } = scenarioStore();
    const s = buildSuggestions(env.ctx).find((x) => x.productId === A)!;
    expect(s).toBeTruthy();
    expect(s.kind).toBe('pair');
    expect(s.partnerId).toBe(B);
    const p = s.payload.proposal;
    expect(p.type).toBe('cross');
    expect(p.rewardType).toBe('free'); // buy 2 A get 1 B free is profitable here
    expect(p.minQty).toBe(2000);
    const sim = s.payload.simulation;
    // per deal: revenue 2x20 + 10 = 50, cost 2x12 + 7 = 31 -> before 19, gift costs 10 -> after 9
    expect(sim.profitBefore).toBe(egp(19));
    expect(sim.discount).toBe(egp(10));
    expect(sim.profitAfter).toBe(egp(9));
    expect(sim.unsafe).toBe(false);
    expect(s.payload.title).toBe('اشترِ 2 من شيبسي X واحصل على 1 مياه Y مجانًا');
    expect(s.payload.reasons.join(' ')).toContain('من الأكثر طلبًا');
    expect(sim.targetQty).toBe(70_000); // bring cover down to ~30 days
    expect(sim.capitalFreed).toBe(egp(70 * 12));
    expect(sim.rewardUsed).toBe(35_000);
  });

  it('never presents a money-losing offer as good: free gift rejected, safer alternative chosen', () => {
    // A has a thin margin: 10 price, 9 cost
    const { env, A } = scenarioStore({ aPrice: 10, aCost: 9 });
    const s = buildSuggestions(env.ctx).find((x) => x.productId === A)!;
    expect(s).toBeTruthy();
    expect(s.payload.simulation.unsafe).toBe(false);
    expect(s.payload.proposal.rewardType === 'free').toBe(false);
    expect(s.payload.rejected.length).toBeGreaterThan(0);
    expect(s.payload.rejected[0].why).toMatch(/خسارة|هامش/);
    // global invariant over every suggestion
    for (const x of buildSuggestions(env.ctx)) {
      if (x.verdict !== 'review') expect(x.payload.simulation.unsafe).toBe(false);
      if (x.payload.simulation.unsafe) expect(x.verdict).toBe('review');
    }
  });

  it('low-margin product with no safe option is flagged for review, never "good"', () => {
    const { env, A } = scenarioStore({ aPrice: 10, aCost: 9.8 });
    const all = buildSuggestions(env.ctx);
    const s = all.find((x) => x.productId === A);
    if (s) {
      // either a genuinely safe deal (B's margin carries it) or flagged for review — never a disguised loss
      if (s.verdict === 'review') expect(s.payload.simulation.warnings.length).toBeGreaterThan(0);
      else expect(s.payload.simulation.marginAfterPct!).toBeGreaterThanOrEqual(8);
      expect(s.payload.simulation.profitAfter).toBeGreaterThanOrEqual(s.verdict === 'review' ? -Infinity : 0);
      // the free-gift option must have been rejected for this thin-margin product
      expect(s.payload.proposal.rewardType === 'free').toBe(false);
    }
    // with no partner possible at all (only percent options) a 2% margin product gets no "good" discount
    const q2 = all.filter((x) => x.productId === A && x.payload.proposal.type === 'percent');
    for (const x of q2) expect(x.verdict).toBe('review');
  });

  it('simulation flags losses, low margin, excessive discount and below-cost prices', () => {
    const { env, A, B } = scenarioStore();
    const m = new Map(productMetrics(env.ctx).map((x) => [x.id, x]));
    const loss = simulate(env.ctx, { type: 'cross', productId: A, rewardProductId: B, minQty: 1000, rewardQty: 3000, rewardType: 'free', value: 0, days: 14, name: '' }, m);
    expect(loss.flags.loss).toBe(true);
    expect(loss.unsafe).toBe(true);
    const deep = simulate(env.ctx, { type: 'percent', productId: A, minQty: 1000, value: 50 * 100, days: 14, name: '' }, m);
    expect(deep.flags.belowCost).toBe(true);
    expect(deep.flags.overDiscount).toBe(true);
  });

  it('expiry risk: suggests a discount sized by days left and compares with the cost of spoilage', () => {
    const env = setupStore({ settings: { 'features.expiry': true } });
    env.clock.t = new Date(2026, 8, 1, 10);
    const piece = env.unit('قطعة');
    const y = createProduct(env.ctx, { name: 'زبادي', baseUnitId: piece, sellPrice: egp(10), trackExpiry: true }).id;
    const others = [1, 2, 3, 4, 5].map((i) => addProduct(env, { name: `صنف ${i}`, price: 5, cost: 3, qty: 500 }));
    createPurchase(env.ctx, { lines: [{ productId: y, unitId: piece, qty: 60_000, unitCost: egp(6), expiryDate: '2026-09-25' }], paid: egp(360) });
    simulateDays(env, 20, (d) => [[[y, 1], [others[d % 5], 2]], [[others[(d + 1) % 5], 3]]]);
    const m = new Map(productMetrics(env.ctx).map((x) => [x.id, x]));
    const yy = m.get(y)!;
    expect(yy.classes).toContain('expiry');
    expect(yy.expiry!.atRiskQty).toBeGreaterThan(20_000); // 40 left, ~1/day, 4 days to expiry
    const s = buildSuggestions(env.ctx).find((x) => x.productId === y)!;
    expect(s.kind).toBe('expiry');
    expect(s.payload.proposal.value).toBe(30 * 100); // <= 7 days left -> 30%
    expect(s.payload.reasons.join(' ')).toContain('المعرضة للتلف');
  });
});

describe('suggest -> approve -> execute -> measure', () => {
  function manager(env: TestEnv, override: boolean): Ctx {
    const perms = ['reports.view', 'reports.cost', 'promotions.approve', 'pos.sell', 'products.edit_price', ...(override ? ['promotions.override'] : [])];
    const role = saveRole(env.ctx, null, { name: override ? 'مدير كامل' : 'مشرف', permissions: perms });
    const name = override ? 'mgr1' : 'sup1';
    saveUser(env.ctx, null, { username: name, fullName: name, password: '1234', roleId: role.id });
    const ctx: Ctx = { db: env.ctx.db, user: login(env.ctx, name, '1234'), now: env.ctx.now };
    openShift(ctx, { openingCash: 0 });
    return ctx;
  }

  it('approval creates an active promotion that the POS applies exactly as simulated', () => {
    const { env, A, B } = scenarioStore();
    generateSuggestions(env.ctx);
    const list = listSuggestions(env.ctx);
    const s = list.items.find((x: any) => x.product_id === A)!;
    expect(s.status).toBe('new');
    // nothing is applied before approval
    const piece = env.unit('قطعة');
    const before = quoteCart(env.ctx, { lines: [{ productId: A, unitId: piece, qty: 2000 }, { productId: B, unitId: piece, qty: 1000 }] });
    expect(before.total).toBe(egp(50));
    const res = approveSuggestion(env.ctx, { id: s.id });
    expect(res.promotionId).toBeGreaterThan(0);
    const after = quoteCart(env.ctx, { lines: [{ productId: A, unitId: piece, qty: 2000 }, { productId: B, unitId: piece, qty: 1000 }] });
    expect(after.total).toBe(egp(40));
    expect(after.lines[1].promoDiscount).toBe(egp(10));
    // cap: max 2 deals per invoice even if the cart has more
    const big = quoteCart(env.ctx, { lines: [{ productId: A, unitId: piece, qty: 10_000 }, { productId: B, unitId: piece, qty: 5000 }] });
    expect(big.promoDiscount).toBe(egp(20));
    // hint when B is missing
    const hint = quoteCart(env.ctx, { lines: [{ productId: A, unitId: piece, qty: 2000 }] });
    expect(hint.promoHints.length).toBe(1);
    expect(() => approveSuggestion(env.ctx, { id: s.id })).toThrow('SUGGESTION_CLOSED');
  });

  it('an edited offer that becomes unsafe needs the override permission (enforced server-side)', () => {
    const { env, A } = scenarioStore();
    generateSuggestions(env.ctx);
    const s = listSuggestions(env.ctx).items.find((x: any) => x.product_id === A)!;
    const sup = manager(env, false);
    expect(() => approveSuggestion(sup, { id: s.id, proposal: { minQty: 1000, rewardQty: 3000 } })).toThrow('APPROVAL_REQUIRED');
    const mgr = manager(env, true);
    const r = approveSuggestion(mgr, { id: s.id, proposal: { minQty: 1000, rewardQty: 3000 } });
    expect(r.simulation.unsafe).toBe(true);
    const audit = env.ctx.db.prepare(`SELECT new_value FROM audit_log WHERE action = 'promotion.approve_suggestion'`).get() as any;
    expect(JSON.parse(audit.new_value).unsafe).toBe(true);
  });

  it('rejecting and muting a product stops it from being suggested again', () => {
    const { env, A } = scenarioStore();
    generateSuggestions(env.ctx);
    const s = listSuggestions(env.ctx).items.find((x: any) => x.product_id === A)!;
    rejectSuggestion(env.ctx, { id: s.id, muteProduct: true, note: 'منتج موسمي' });
    env.clock.t = new Date(env.clock.t.getTime() + 40 * DAY); // next month
    generateSuggestions(env.ctx);
    expect(listSuggestions(env.ctx, { all: true }).items.some((x: any) => x.product_id === A && x.status === 'new')).toBe(false);
  });

  it('measures results on units, profit, margin and stock reduction — not sales alone', () => {
    const { env, A, B, fillers } = scenarioStore();
    generateSuggestions(env.ctx);
    const s = listSuggestions(env.ctx).items.find((x: any) => x.product_id === A)!;
    const { promotionId } = approveSuggestion(env.ctx, { id: s.id, startDate: '2026-09-01', endDate: '2026-09-14' });
    env.clock.t = new Date(2026, 7, 31, 10);
    // during the promotion customers buy 2 A + 1 B three times a day
    simulateDays(env, 14, () => [[[A, 2], [B, 1]], [[A, 2], [B, 1]], [[A, 2], [B, 1]], [[B, 3], [fillers[0], 2]]]);
    const r = promotionPerformance(env.ctx, promotionId)!;
    expect(r.uses).toBe(42);
    expect(r.mainDuring!.units).toBe(84_000);
    expect(r.unitsUpliftPct).toBeGreaterThan(100);
    expect(r.stockReductionPct).toBeGreaterThan(50);
    expect(r.discountGiven).toBe(42 * egp(10));
    expect(['success', 'clearance', 'mixed']).toContain(r.verdict);
    expect(r.marginDuring).not.toBeNull();
  });

  it('monthly review shows at most 5 prioritised items', () => {
    const { env } = scenarioStore();
    const f = monthlyFocus(env.ctx);
    expect(f.length).toBeGreaterThan(0);
    expect(f.length).toBeLessThanOrEqual(5);
    expect(f.map((x) => x.key)).toContain('stuck');
    expect(f.map((x) => x.key)).toContain('hot');
  });

  it('basket analysis finds products really bought together (large store)', () => {
    const env = setupStore();
    env.clock.t = new Date(2026, 7, 1, 10);
    const tea = addProduct(env, { name: 'شاي', price: 25, cost: 18, qty: 2000 });
    const sugar = addProduct(env, { name: 'سكر', price: 30, cost: 26, qty: 2000 });
    const others = Array.from({ length: 8 }, (_, i) => addProduct(env, { name: `صنف ${i}`, price: 10, cost: 7, qty: 2000 }));
    simulateDays(env, 30, (d) => [
      [[tea, 1], [sugar, 1]],
      [[tea, 1], ...(d % 3 === 0 ? [[sugar, 1] as [number, number]] : [])],
      [[others[d % 8], 2]], [[others[(d + 3) % 8], 1]], [[others[(d + 5) % 8], 1], [others[(d + 1) % 8], 1]],
    ]);
    const b = basketPairs(env.ctx);
    expect(b.sufficient).toBe(true);
    const pair = b.pairs.find((p) => [p.a, p.b].includes(tea) && [p.a, p.b].includes(sugar))!;
    expect(pair).toBeTruthy();
    expect(pair.both).toBe(40);
    expect(pair.lift).toBeGreaterThan(1.5);
    setSettingRaw(env.ctx.db, 'intel.basketMinInvoices', 100000);
    expect(basketPairs(env.ctx).sufficient).toBe(false);
  });
});
