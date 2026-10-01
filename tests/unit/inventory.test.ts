import { describe, it, expect } from 'vitest';
import { setupStore, addProduct, egp, asRole } from './helpers';
import { createAdjustment, createTransfer, completeStocktake, getStock, productLedger, setStocktakeCount, startStocktake, totalStock, saveLocation, listBatches } from '../../src/main/services/inventory';
import { createPurchase } from '../../src/main/services/purchases';
import { checkout, createReturn } from '../../src/main/services/sales';
import { setSettingRaw, defaultLocationId } from '../../src/main/services/context';
import { createProduct, getProduct } from '../../src/main/services/products';
import { saveParty } from '../../src/main/services/parties';

describe('units & conversion (spec §11)', () => {
  it('buying 2 cartons of 30 bags gives 60 bags; selling 3 leaves 57', () => {
    const env = setupStore();
    const bag = env.unit('كيس');
    const carton = env.unit('كرتونة');
    const id = createProduct(env.ctx, {
      name: 'شيبسي', baseUnitId: bag, sellPrice: egp(5),
      units: [{ unitId: carton, factor: 30_000, isDefaultPurchase: true }],
    }).id;
    createPurchase(env.ctx, { lines: [{ productId: id, unitId: carton, qty: 2000, unitCost: egp(90) }], paid: egp(180) });
    expect(totalStock(env.ctx, id)).toBe(60_000);
    // cost per bag = 90 / 30 = 3
    expect(getProduct(env.ctx, id).avg_cost).toBeCloseTo(300, 4);
    checkout(env.ctx, { cart: { lines: [{ productId: id, unitId: bag, qty: 3000 }] }, payments: [{ method: 'cash', amount: egp(15) }] });
    expect(totalStock(env.ctx, id)).toBe(57_000);
  });

  it('water carton of 12 sells as a carton at its own price and as single bottles', () => {
    const env = setupStore();
    const bottle = env.unit('زجاجة');
    const carton = env.unit('كرتونة');
    const id = createProduct(env.ctx, { name: 'مياه', baseUnitId: bottle, sellPrice: egp(6), units: [{ unitId: carton, factor: 12_000, sellPrice: egp(65) }], openingStock: { qty: 48_000, unitCost: egp(4) } }).id;
    const s = checkout(env.ctx, { cart: { lines: [{ productId: id, unitId: carton, qty: 1000 }, { productId: id, unitId: bottle, qty: 2000 }] }, payments: [{ method: 'cash', amount: egp(77) }] });
    expect(s.total).toBe(egp(65 + 12));
    expect(totalStock(env.ctx, id)).toBe(48_000 - 14_000);
    expect(s.cogs).toBe(egp(14 * 4));
  });

  it('rejects fractional quantities for count units', () => {
    const env = setupStore();
    const id = addProduct(env, { name: 'تونة', price: 45, qty: 10 });
    expect(() => checkout(env.ctx, { cart: { lines: [{ productId: id, unitId: env.unit('قطعة'), qty: 1500 }] }, payments: [{ method: 'cash', amount: egp(100) }] })).toThrow('DECIMAL_NOT_ALLOWED');
  });
});

describe('inventory ledger (spec §15/16)', () => {
  it('records before/after for every movement and explains where stock went', () => {
    const env = setupStore();
    const id = addProduct(env, { name: 'بسكويت', price: 5, cost: 3, qty: 50 });
    checkout(env.ctx, { cart: { lines: [{ productId: id, unitId: env.unit('قطعة'), qty: 3000 }] }, payments: [{ method: 'cash', amount: egp(15) }] });
    createAdjustment(env.ctx, { type: 'damage', reason: 'كسر', lines: [{ productId: id, qty: 2000 }] });
    const ledger = productLedger(env.ctx, id) as any[];
    expect(ledger.map((m) => [m.type, m.qty, m.qty_before, m.qty_after])).toEqual([
      ['damage', -2000, 47000, 45000],
      ['sale', -3000, 50000, 47000],
      ['opening', 50000, 0, 50000],
    ]);
    // the ledger always reconciles to the stock figure
    const sum = ledger.reduce((a, m) => a + m.qty, 0);
    expect(sum).toBe(totalStock(env.ctx, id));
  });

  it('stocktake creates an adjustment for the difference instead of silently overwriting', () => {
    const env = setupStore();
    const id = addProduct(env, { name: 'زيت', price: 80, cost: 60, qty: 37 });
    const st = startStocktake(env.ctx, {});
    setStocktakeCount(env.ctx, st.id, id, 34_000);
    const r = completeStocktake(env.ctx, st.id);
    expect(r.adjusted).toBe(1);
    expect(r.valueDiff).toBe(-egp(180));
    expect(totalStock(env.ctx, id)).toBe(34_000);
    const last = (productLedger(env.ctx, id) as any[])[0];
    expect(last.type).toBe('stocktake');
    expect(last.qty).toBe(-3000);
  });

  it('stocktake uses the stock at confirmation time (sales during the count are respected)', () => {
    const env = setupStore();
    const id = addProduct(env, { name: 'سكر', price: 30, cost: 25, qty: 20 });
    const other = addProduct(env, { name: 'أرز', price: 30, cost: 25, qty: 10 });
    const st = startStocktake(env.ctx, {});
    setStocktakeCount(env.ctx, st.id, id, 18_000); // counted 18 after 2 were sold
    checkout(env.ctx, { cart: { lines: [{ productId: id, unitId: env.unit('قطعة'), qty: 2000 }] }, payments: [{ method: 'cash', amount: egp(60) }] });
    completeStocktake(env.ctx, st.id);
    expect(totalStock(env.ctx, id)).toBe(18_000);
    expect(totalStock(env.ctx, other)).toBe(10_000); // uncounted items untouched
  });

  it('transfers between locations keep the total and move the cost', () => {
    const env = setupStore();
    setSettingRaw(env.ctx.db, 'features.multiLocation', true);
    const wh = saveLocation(env.ctx, { name: 'المخزن', type: 'warehouse' }).id;
    const shop = defaultLocationId(env.ctx.db);
    const id = addProduct(env, { name: 'مياه', price: 6, cost: 4, qty: 100 });
    createTransfer(env.ctx, { fromLocationId: shop, toLocationId: wh, lines: [{ productId: id, qty: 40_000 }] });
    expect(getStock(env.ctx, id, shop)).toBe(60_000);
    expect(getStock(env.ctx, id, wh)).toBe(40_000);
    expect(totalStock(env.ctx, id)).toBe(100_000);
  });

  it('blocks overselling when negative stock is disabled', () => {
    const env = setupStore({ settings: { 'sales.allowNegativeStock': false } });
    const id = addProduct(env, { name: 'لبن', price: 20, qty: 1 });
    const cashier = asRole(env, 'cashier', { shift: true });
    expect(() => checkout(cashier, { cart: { lines: [{ productId: id, unitId: env.unit('قطعة'), qty: 2000 }] }, payments: [{ method: 'cash', amount: egp(40) }] })).toThrow('INSUFFICIENT_STOCK');
    expect(totalStock(env.ctx, id)).toBe(1000); // nothing changed (atomic)
  });
});

describe('weighted average cost (spec §26)', () => {
  it('averages purchase costs and keeps historical invoice profit unchanged', () => {
    const env = setupStore();
    const piece = env.unit('قطعة');
    const id = addProduct(env, { name: 'نسكافيه', price: 20, cost: 10, qty: 10 });
    const s1 = checkout(env.ctx, { cart: { lines: [{ productId: id, unitId: piece, qty: 2000 }] }, payments: [{ method: 'cash', amount: egp(40) }] });
    expect(s1.cogs).toBe(egp(20));
    // buy 8 more at 15 -> avg = (8*10 + 8*15) / 16 = 12.5
    createPurchase(env.ctx, { lines: [{ productId: id, unitId: piece, qty: 8000, unitCost: egp(15) }], paid: egp(120) });
    expect(getProduct(env.ctx, id).avg_cost).toBeCloseTo(1250, 4);
    const s2 = checkout(env.ctx, { cart: { lines: [{ productId: id, unitId: piece, qty: 2000 }] }, payments: [{ method: 'cash', amount: egp(40) }] });
    expect(s2.cogs).toBe(egp(25));
    // the first invoice still shows its original cost
    const again = env.ctx.db.prepare('SELECT cogs FROM sales WHERE id = ?').get(s1.id) as { cogs: number };
    expect(again.cogs).toBe(egp(20));
  });

  it('invoice-level discount and extra charges are allocated into landed cost', () => {
    const env = setupStore();
    const piece = env.unit('قطعة');
    const a = addProduct(env, { name: 'A', price: 10 });
    const b = addProduct(env, { name: 'B', price: 10 });
    createPurchase(env.ctx, {
      lines: [{ productId: a, unitId: piece, qty: 10_000, unitCost: egp(6) }, { productId: b, unitId: piece, qty: 10_000, unitCost: egp(4) }],
      discount: egp(10), tax: 0, paid: egp(90),
    });
    // 100 total, discount 10 split 60/40 -> A landed 54 (5.4 each), B 36 (3.6 each)
    expect(getProduct(env.ctx, a).avg_cost).toBeCloseTo(540, 4);
    expect(getProduct(env.ctx, b).avg_cost).toBeCloseTo(360, 4);
  });

  it('returns at original cost do not distort the average', () => {
    const env = setupStore();
    const piece = env.unit('قطعة');
    const id = addProduct(env, { name: 'شاي', price: 30, cost: 20, qty: 10 });
    const s = checkout(env.ctx, { cart: { lines: [{ productId: id, unitId: piece, qty: 4000 }] }, payments: [{ method: 'cash', amount: egp(120) }] });
    createPurchase(env.ctx, { lines: [{ productId: id, unitId: piece, qty: 6000, unitCost: egp(26) }], paid: egp(156) });
    // avg = (6*20 + 6*26)/12 = 23
    expect(getProduct(env.ctx, id).avg_cost).toBeCloseTo(2300, 4);
    createReturn(env.ctx, { saleId: s.id, items: [{ saleItemId: s.items[0].id, qty: 4000, restock: true }], refundMethod: 'cash' });
    // 12*23 + 4*20 = 356 / 16 = 22.25
    expect(getProduct(env.ctx, id).avg_cost).toBeCloseTo(2225, 4);
    expect(totalStock(env.ctx, id)).toBe(16_000);
  });
});

describe('expiry & batches (spec §24/25)', () => {
  it('requires expiry on purchase, sells first-expiring first, and restores batches on return', () => {
    const env = setupStore({ settings: { 'features.expiry': true } });
    const piece = env.unit('قطعة');
    const sup = saveParty(env.ctx, 'supplier', null, { name: 'مورد الألبان' }).id;
    const id = createProduct(env.ctx, { name: 'زبادي', baseUnitId: piece, sellPrice: egp(8), trackExpiry: true }).id;
    expect(() => createPurchase(env.ctx, { supplierId: sup, lines: [{ productId: id, unitId: piece, qty: 10_000, unitCost: egp(5) }], paid: egp(50) })).toThrow('EXPIRY_REQUIRED');
    createPurchase(env.ctx, { supplierId: sup, lines: [{ productId: id, unitId: piece, qty: 10_000, unitCost: egp(5), expiryDate: '2026-12-01' }], paid: egp(50) });
    createPurchase(env.ctx, { supplierId: sup, lines: [{ productId: id, unitId: piece, qty: 10_000, unitCost: egp(5), expiryDate: '2026-10-15' }], paid: egp(50) });
    const s = checkout(env.ctx, { cart: { lines: [{ productId: id, unitId: piece, qty: 12_000 }] }, payments: [{ method: 'cash', amount: egp(96) }] });
    const batches = listBatches(env.ctx, id) as any[];
    const byExp = Object.fromEntries(batches.map((b) => [b.expiry_date, b.qty]));
    expect(byExp['2026-10-15']).toBe(0);
    expect(byExp['2026-12-01']).toBe(8_000);
    createReturn(env.ctx, { saleId: s.id, items: [{ saleItemId: s.items[0].id, qty: 3000, restock: true }], refundMethod: 'cash' });
    const after = Object.fromEntries((listBatches(env.ctx, id) as any[]).map((b) => [b.expiry_date, b.qty]));
    expect(after['2026-12-01'] + after['2026-10-15']).toBe(11_000);
    expect(totalStock(env.ctx, id)).toBe(11_000);
  });
});
