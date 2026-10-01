import { describe, it, expect } from 'vitest';
import { setupStore, addProduct, egp } from './helpers';
import { checkout, quoteCart } from '../../src/main/services/sales';
import { totalStock } from '../../src/main/services/inventory';

describe('real store scenario (spec §5)', () => {
  it('sells a mixed basket with pieces and weighed items', () => {
    const env = setupStore();
    const kg = env.unit('كيلو');
    const gram = env.unit('جرام');
    const piece = env.unit('قطعة');
    const ids = {
      chipsA: addProduct(env, { name: 'شيبسي A', price: 10, cost: 7, qty: 50 }),
      chipsB: addProduct(env, { name: 'شيبسي B', price: 15, cost: 11, qty: 50 }),
      iceA: addProduct(env, { name: 'آيس كريم A', price: 20, cost: 15, qty: 24 }),
      iceB: addProduct(env, { name: 'آيس كريم B', price: 25, cost: 19, qty: 24 }),
      coke: addProduct(env, { name: 'كوكاكولا', price: 15, cost: 12, qty: 24 }),
      pepsi: addProduct(env, { name: 'بيبسي', price: 15, cost: 12, qty: 24 }),
      tuna: addProduct(env, { name: 'تونة دولفين', price: 45, cost: 38, qty: 10 }),
      cheese: addProduct(env, { name: 'جبنة رومي', price: 180, cost: 140, unit: 'كيلو', weighted: true, qty: 5, units: [{ unit: 'جرام', factor: 0.001 }] }),
      luncheon: addProduct(env, { name: 'لانشون', price: 160, cost: 120, unit: 'كيلو', weighted: true, qty: 3, units: [{ unit: 'جرام', factor: 0.001 }] }),
    };
    const lines = [
      { productId: ids.chipsA, unitId: piece, qty: 1000 },
      { productId: ids.chipsB, unitId: piece, qty: 1000 },
      { productId: ids.iceA, unitId: piece, qty: 1000 },
      { productId: ids.iceB, unitId: piece, qty: 1000 },
      { productId: ids.coke, unitId: piece, qty: 1000 },
      { productId: ids.pepsi, unitId: piece, qty: 1000 },
      { productId: ids.tuna, unitId: piece, qty: 1000 },
      { productId: ids.cheese, unitId: gram, qty: 250_000 }, // 250 g
      { productId: ids.luncheon, unitId: kg, qty: 150 }, // 0.150 kg
    ];
    const q = quoteCart(env.ctx, { lines });
    const cheeseLine = q.lines.find((l) => l.productId === ids.cheese)!;
    expect(cheeseLine.gross).toBe(egp(45)); // 180 x 0.25
    const lunch = q.lines.find((l) => l.productId === ids.luncheon)!;
    expect(lunch.gross).toBe(egp(24)); // 160 x 0.15
    const expected = 10 + 15 + 20 + 25 + 15 + 15 + 45 + 45 + 24;
    expect(q.total).toBe(egp(expected));
    const sale = checkout(env.ctx, { cart: { lines }, payments: [{ method: 'cash', amount: egp(300) }], clientRef: 'scenario-1' });
    expect(sale.total).toBe(egp(expected));
    expect(sale.change_due).toBe(egp(300 - expected));
    expect(totalStock(env.ctx, ids.cheese)).toBe(4750); // 5kg - 250g
    expect(totalStock(env.ctx, ids.luncheon)).toBe(2850);
    expect(totalStock(env.ctx, ids.chipsA)).toBe(49000);
    const cogs = 7 + 11 + 15 + 19 + 12 + 12 + 38 + 140 * 0.25 + 120 * 0.15;
    expect(sale.cogs).toBe(egp(cogs));
    // idempotent re-submit returns the same invoice
    const again = checkout(env.ctx, { cart: { lines }, payments: [{ method: 'cash', amount: egp(300) }], clientRef: 'scenario-1' });
    expect(again.id).toBe(sale.id);
    expect(totalStock(env.ctx, ids.cheese)).toBe(4750);
  });
});
