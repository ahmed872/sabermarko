import { describe, it, expect } from 'vitest';
import { setupStore, egp, asRole, approverCtx, type TestEnv } from './helpers';
import { createProduct } from '../../src/main/services/products';
import { saveParty, recordPayment } from '../../src/main/services/parties';
import { createPurchase, createPurchaseReturn } from '../../src/main/services/purchases';
import { checkout, createReturn, quoteCart } from '../../src/main/services/sales';
import { listBatches, totalStock, sellableStock } from '../../src/main/services/inventory';
import { alerts, expiryOverview, financialSummary } from '../../src/main/services/reports';
import { setSettingRaw } from '../../src/main/services/context';
import { errorMessage } from '../../src/shared/errors';

/**
 * Batch / expiry / supplier-return cycle (tests A–J, N, O of the batch spec).
 * Milk X: a carton = 12 pieces. Batch 1: 10 cartons @ 200 EGP, expiry 2027-01-15.
 * Batch 2: 5 cartons @ 220 EGP, expiry 2027-04-20.
 */
function milkStore(settings: Record<string, unknown> = {}) {
  const env = setupStore({ settings: { 'features.expiry': true, ...settings } });
  env.clock.t = new Date(2026, 9, 1, 10); // 1 Oct 2026
  const piece = env.unit('قطعة');
  const carton = env.unit('كرتونة');
  const nile = saveParty(env.ctx, 'supplier', null, { name: 'ألبان النيل' }).id;
  const delta = saveParty(env.ctx, 'supplier', null, { name: 'ألبان الدلتا' }).id;
  const milk = createProduct(env.ctx, { name: 'لبن X', baseUnitId: piece, sellPrice: egp(25), trackExpiry: true, units: [{ unitId: carton, factor: 12_000, isDefaultPurchase: true }] }).id;
  const buy = (supplierId: number, cartons: number, cost: number, expiryDate: string, batchNo?: string) =>
    createPurchase(env.ctx, { supplierId, lines: [{ productId: milk, unitId: carton, qty: cartons * 1000, unitCost: egp(cost), expiryDate, batchNo: batchNo ?? null }], paid: 0 }) as any;
  const batches = () => (listBatches(env.ctx, milk) as any[]).sort((a, b) => a.id - b.id);
  const sell = (ctx: TestEnv['ctx'], pieces: number) => checkout(ctx, { cart: { lines: [{ productId: milk, unitId: piece, qty: pieces * 1000 }] }, payments: [{ method: 'cash', amount: egp(25 * pieces) }] }) as any;
  const balance = (id: number) => (env.ctx.db.prepare('SELECT balance FROM suppliers WHERE id = ?').get(id) as { balance: number }).balance;
  return { env, piece, carton, nile, delta, milk, buy, batches, sell, balance };
}

describe('batches keep their own quantity, cost, expiry and supplier', () => {
  it('A: 10 cartons x 12 enter stock as 120 pieces in one batch with its expiry, cost, supplier and purchase line', () => {
    const { env, nile, milk, buy, batches } = milkStore();
    const p = buy(nile, 10, 200, '2027-01-15', 'B-2026-10');
    const [b] = batches();
    expect(b).toMatchObject({ qty: 120_000, initial_qty: 120_000, expiry_date: '2027-01-15', batch_no: 'B-2026-10', supplier_id: nile, ref_type: 'purchase', ref_id: p.id });
    expect(b.unit_cost).toBeCloseTo((200 * 100) / 12, 6); // per piece
    expect(b.purchase_item_id).toBe(p.items[0].id);
    expect(p.items[0]).toMatchObject({ qty: 10_000, factor: 12_000, base_qty: 120_000, batch_id: b.id });
    expect(totalStock(env.ctx, milk)).toBe(120_000);
    const mv = env.ctx.db.prepare(`SELECT type, qty FROM stock_movements WHERE product_id = ?`).all(milk);
    expect(mv).toEqual([{ type: 'purchase', qty: 120_000 }]);
  });

  it('B + N: a second delivery is a separate batch and never changes the first one — even with the same expiry', () => {
    const { nile, delta, buy, batches } = milkStore();
    buy(nile, 10, 200, '2027-01-15');
    const before = { ...batches()[0] };
    buy(delta, 5, 220, '2027-04-20');
    buy(delta, 2, 240, '2027-01-15'); // same date as batch 1, different supplier and cost
    const bs = batches();
    expect(bs).toHaveLength(3);
    expect(bs[0]).toEqual(before); // untouched
    expect(bs[1]).toMatchObject({ qty: 60_000, expiry_date: '2027-04-20', supplier_id: delta });
    expect(bs[1].unit_cost).toBeCloseTo((220 * 100) / 12, 6);
    expect(bs[2]).toMatchObject({ qty: 24_000, expiry_date: '2027-01-15', supplier_id: delta });
    expect(bs[2].unit_cost).toBeCloseTo(2000, 6);
  });

  it('C: FEFO — a sale takes the batch that expires first, whatever the order of delivery', () => {
    const { env, nile, delta, buy, batches, sell } = milkStore();
    buy(delta, 5, 220, '2027-04-20'); // delivered first, expires last
    buy(nile, 10, 200, '2027-01-15');
    const s = sell(env.ctx, 130);
    const bs = batches();
    expect(bs.find((b) => b.expiry_date === '2027-01-15').qty).toBe(0);
    expect(bs.find((b) => b.expiry_date === '2027-04-20').qty).toBe(50_000);
    const alloc = env.ctx.db.prepare(`SELECT b.expiry_date, sib.qty FROM sale_item_batches sib JOIN batches b ON b.id = sib.batch_id WHERE sib.sale_item_id = ? ORDER BY b.expiry_date`).all(s.items[0].id);
    expect(alloc).toEqual([{ expiry_date: '2027-01-15', qty: 120_000 }, { expiry_date: '2027-04-20', qty: 10_000 }]);
  });

  it('D: expired batches are never sold — only valid batches, and a clear Arabic refusal when valid stock is short (even with negative stock allowed)', () => {
    const { env, nile, delta, buy, batches, sell } = milkStore({ 'sales.allowNegativeStock': true });
    buy(nile, 10, 200, '2027-01-15');
    buy(delta, 5, 220, '2027-04-20');
    env.clock.t = new Date(2027, 0, 16, 10); // batch 1 expired yesterday
    expect(sellableStock(env.ctx, batches()[0].product_id, batches()[0].location_id)).toMatchObject({ onHand: 180_000, sellable: 60_000, expired: 120_000 });
    sell(env.ctx, 10); // comes from the valid batch only
    expect(batches().map((b) => b.qty)).toEqual([120_000, 50_000]);
    // asking for more than the valid quantity is refused at quote and at checkout, and nothing changes
    const cart = { lines: [{ productId: batches()[0].product_id, unitId: env.unit('قطعة'), qty: 60_000 }] };
    expect(() => quoteCart(env.ctx, cart)).toThrow('EXPIRED_STOCK');
    const sales = (env.ctx.db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n;
    try { sell(env.ctx, 60); expect.unreachable(); } catch (e: any) {
      expect(e.code).toBe('EXPIRED_STOCK');
      expect(errorMessage(e.code, e.params)).toBe('لا يمكن بيع "لبن X": الكمية الصالحة للبيع 50 فقط، ويوجد 120 منتهية الصلاحية لا يجوز بيعها. سجّلها كتالف أو أرجعها للمورد.');
    }
    expect((env.ctx.db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n).toBe(sales);
    expect(batches().map((b) => b.qty)).toEqual([120_000, 50_000]);
    // a cashier hits the same domain rule
    const cashier = asRole(env, 'cashier', { shift: true });
    expect(() => sell(cashier, 51)).toThrow('EXPIRED_STOCK');
  });

  it('E: expiry alerts follow the configured tiers (near → very near → expired) with the product, quantity and days left', () => {
    const { env, nile, buy } = milkStore();
    buy(nile, 2, 200, '2027-01-15');
    env.clock.t = new Date(2026, 9, 1, 10);
    expect(alerts(env.ctx).some((a) => a.key.startsWith('expir'))).toBe(false); // 106 days away
    expect(expiryOverview(env.ctx).items).toHaveLength(0);
    env.clock.t = new Date(2026, 11, 1, 10); // 45 days: "watch" tier only
    expect(expiryOverview(env.ctx).items[0]).toMatchObject({ tier: 'watch', days_left: 45, supplier_name: 'ألبان النيل', qty: 24_000 });
    expect(alerts(env.ctx).some((a) => a.key.startsWith('expir'))).toBe(false);
    env.clock.t = new Date(2026, 11, 28, 10); // 18 days
    const near = alerts(env.ctx).find((a) => a.key === 'expiring_near')!;
    expect(near.level).toBe('warning');
    expect(near.text).toBe('⚠️ يوجد 24 قطعة من لبن X ستنتهي خلال 18 يومًا.');
    env.clock.t = new Date(2027, 0, 10, 10); // 5 days
    expect(alerts(env.ctx).find((a) => a.key === 'expiring')).toMatchObject({ level: 'danger' });
    const o = expiryOverview(env.ctx);
    expect(o.items[0]).toMatchObject({ tier: 'critical', action: 'return' });
    expect(o.items[0].value).toBe(egp(400));
    env.clock.t = new Date(2027, 0, 16, 10);
    expect(alerts(env.ctx).find((a) => a.key === 'expired')).toMatchObject({ level: 'danger' });
    expect(expiryOverview(env.ctx).summary.find((s) => s.tier === 'expired')).toMatchObject({ batches: 1, qty: 24_000 });
    // thresholds are settings
    setSettingRaw(env.ctx.db, 'inventory.expiryWatchDays', 120);
    expect(expiryOverview(env.ctx).thresholds.watch).toBe(120);
  });
});

describe('supplier return of a specific batch', () => {
  it('F + H + I + J: returns from the chosen batch only; stock, ledger, supplier balance and audit all agree', () => {
    const { env, piece, nile, delta, milk, buy, batches, balance } = milkStore();
    buy(nile, 10, 200, '2027-01-15');
    buy(delta, 5, 220, '2027-04-20');
    expect(balance(delta)).toBe(egp(1100));
    const b2 = batches()[1];
    // F: return 24 pieces of batch 2 (not the FEFO batch), at the batch's own cost
    const r: any = createPurchaseReturn(env.ctx, { supplierId: delta, refundMethod: 'balance', reason: 'قرب انتهاء الصلاحية', lines: [{ batchId: b2.id, productId: milk, unitId: piece, qty: 24_000 }] });
    const bs = batches();
    expect(bs[0].qty).toBe(120_000); // batch 1 untouched
    expect(bs[1].qty).toBe(36_000);
    expect(r.total).toBe(egp(440)); // 24 x 220/12
    expect(env.ctx.db.prepare('SELECT batch_id, base_qty, total FROM purchase_return_items WHERE return_id = ?').get(r.id)).toEqual({ batch_id: b2.id, base_qty: 24_000, total: egp(440) });
    // H: inventory = batches = ledger
    expect(totalStock(env.ctx, milk)).toBe(156_000);
    expect(bs.reduce((a, b) => a + b.qty, 0)).toBe(156_000);
    const ledger = env.ctx.db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE product_id = ?').get(milk) as { q: number };
    expect(ledger.q).toBe(156_000);
    expect(env.ctx.db.prepare(`SELECT type, qty, ref_type, ref_id FROM stock_movements WHERE product_id = ? ORDER BY id DESC LIMIT 1`).get(milk)).toEqual({ type: 'purchase_return', qty: -24_000, ref_type: 'purchase_return', ref_id: r.id });
    // I: supplier balance reduced by exactly the return, ledger agrees
    expect(balance(delta)).toBe(egp(1100 - 440));
    expect(balance(nile)).toBe(egp(2000));
    const sl = env.ctx.db.prepare(`SELECT type, amount, balance_after FROM supplier_ledger WHERE supplier_id = ? ORDER BY id`).all(delta);
    expect(sl).toEqual([{ type: 'purchase', amount: egp(1100), balance_after: egp(1100) }, { type: 'return', amount: -egp(440), balance_after: egp(660) }]);
    // J: audited with the batch, reason and user
    const a = env.ctx.db.prepare(`SELECT user_id, reason, new_value FROM audit_log WHERE action = 'purchase.return' AND entity_id = ?`).get(r.id) as any;
    expect(a.user_id).toBe(env.ctx.user!.id);
    expect(a.reason).toBe('قرب انتهاء الصلاحية');
    expect(JSON.parse(a.new_value).lines[0]).toMatchObject({ batchId: b2.id, qty: 24_000, expiry: '2027-04-20' });
  });

  it('G: refuses more than the batch holds, an unknown or foreign batch, or the wrong supplier — atomically', () => {
    const { env, piece, nile, delta, milk, buy, batches, balance } = milkStore();
    buy(nile, 10, 200, '2027-01-15');
    buy(delta, 5, 220, '2027-04-20');
    const [b1, b2] = batches();
    const other = createProduct(env.ctx, { name: 'زبادي', baseUnitId: piece, sellPrice: egp(8) }).id;
    const count = () => (env.ctx.db.prepare('SELECT COUNT(*) AS n FROM purchase_returns').get() as { n: number }).n;
    const ret = (lines: any[], supplierId = delta) => createPurchaseReturn(env.ctx, { supplierId, refundMethod: 'balance', reason: 'منتهي الصلاحية', lines });
    expect(() => ret([{ batchId: b2.id, productId: milk, unitId: piece, qty: 61_000 }])).toThrow('RETURN_EXCEEDS_BATCH');
    expect(() => ret([{ batchId: 99_999, productId: milk, unitId: piece, qty: 1000 }])).toThrow('BATCH_NOT_FOUND');
    expect(() => ret([{ batchId: b2.id, productId: other, unitId: piece, qty: 1000 }])).toThrow('BATCH_NOT_FOUND');
    expect(() => ret([{ batchId: b1.id, productId: milk, unitId: piece, qty: 1000 }], delta)).toThrow('BATCH_SUPPLIER_MISMATCH');
    // second line fails -> first line is rolled back too
    expect(() => ret([{ batchId: b2.id, productId: milk, unitId: piece, qty: 10_000 }, { batchId: b2.id, productId: milk, unitId: piece, qty: 55_000 }])).toThrow('RETURN_EXCEEDS_BATCH');
    expect(count()).toBe(0);
    expect(batches().map((b) => b.qty)).toEqual([120_000, 60_000]);
    expect(totalStock(env.ctx, milk)).toBe(180_000);
    expect(balance(delta)).toBe(egp(1100));
    // after selling the whole batch nothing can be returned from it, and stock never goes negative
    const b2After = env.ctx.db.prepare('UPDATE batches SET qty = 0 WHERE id = ?').run(b2.id);
    void b2After;
    expect(() => ret([{ batchId: b2.id, productId: milk, unitId: piece, qty: 1000 }])).toThrow('RETURN_EXCEEDS_BATCH');
  });

  it('a return of expired goods is allowed (that is the point), and the returned quantity is no longer offered for sale', () => {
    const { env, piece, nile, milk, buy, batches } = milkStore();
    buy(nile, 2, 200, '2027-01-15');
    env.clock.t = new Date(2027, 0, 20, 10);
    createPurchaseReturn(env.ctx, { refundMethod: 'balance', reason: 'منتهي الصلاحية', lines: [{ batchId: batches()[0].id, productId: milk, unitId: piece, qty: 24_000 }] }); // supplier taken from the batch
    expect(batches()[0].qty).toBe(0);
    expect(alerts(env.ctx).some((a) => a.key === 'expired')).toBe(false);
  });
});

describe('O: purchase → sale → customer return → expiry warning → supplier return → reconciliation', () => {
  it('every book agrees and history is not rewritten', () => {
    const { env, piece, nile, delta, milk, buy, batches, sell, balance } = milkStore();
    buy(nile, 10, 200, '2027-01-15');
    const s1 = sell(env.ctx, 30);
    const costOfFirstSale = s1.items[0].cost_total;
    buy(delta, 5, 220, '2027-04-20'); // new cost changes the average, not past sales
    const cashier = asRole(env, 'cashier', { shift: true });
    const s2 = sell(cashier, 20);
    createReturn(approverCtx(env, cashier), { saleId: s2.id, items: [{ saleItemId: s2.items[0].id, qty: 5000, restock: true }], refundMethod: 'cash' });
    recordPayment(env.ctx, 'supplier', { partyId: nile, amount: egp(500), method: 'bank', fromDrawer: false });
    // 15 days before batch 1 expires: warning, then the owner returns 40 pieces of batch 1 to its supplier
    env.clock.t = new Date(2026, 11, 31, 10);
    expect(alerts(env.ctx).find((a) => a.key === 'expiring_near')!.text).toContain('لبن X');
    const b1 = batches()[0];
    const left1 = b1.qty;
    expect(left1).toBe(120_000 - 30_000 - 20_000 + 5000); // FEFO took both sales from batch 1, the return went back to it
    createPurchaseReturn(env.ctx, { supplierId: nile, refundMethod: 'balance', reason: 'قرب انتهاء الصلاحية', lines: [{ batchId: b1.id, productId: milk, unitId: piece, qty: 40_000 }] });

    const bs = batches();
    expect(bs.map((b) => b.qty)).toEqual([left1 - 40_000, 60_000]);
    const stock = totalStock(env.ctx, milk);
    expect(stock).toBe(bs.reduce((a, b) => a + b.qty, 0));
    expect(stock).toBe((env.ctx.db.prepare('SELECT SUM(qty) AS q FROM stock_movements WHERE product_id = ?').get(milk) as { q: number }).q);
    expect(stock).toBe(180_000 - 30_000 - 20_000 + 5000 - 40_000);
    // supplier balances: purchases - payments - returns
    expect(balance(nile)).toBe(egp(2000 - 500) - Math.round((((200 * 100) / 12) * 40_000) / 1000));
    expect(balance(delta)).toBe(egp(1100));
    // historical sale cost is a snapshot: unchanged by later purchases and returns
    expect((env.ctx.db.prepare('SELECT cost_total FROM sale_items WHERE id = ?').get(s1.items[0].id) as { cost_total: number }).cost_total).toBe(costOfFirstSale);
    // reports: revenue and COGS = sales - customer return; supplier return is not revenue
    const f = financialSummary(env.ctx, '2026-01-01', '2027-12-31');
    expect(f.invoices).toBe(2);
    expect(f.netSales).toBe(egp(25 * 50) - egp(25 * 5));
    const purchases = env.ctx.db.prepare(`SELECT COALESCE(SUM(total),0) AS t FROM purchase_returns`).get() as { t: number };
    expect(purchases.t).toBe(Math.round((((200 * 100) / 12) * 40_000) / 1000));
    // audit trail has every step
    const actions = (env.ctx.db.prepare(`SELECT action FROM audit_log ORDER BY id`).all() as { action: string }[]).map((a) => a.action);
    for (const a of ['purchase.create', 'sale.return', 'purchase.return']) expect(actions).toContain(a);
    expect(cashier.user).toBeTruthy();
  });
});
