import { describe, it, expect } from 'vitest';
import { setupStore, egp } from './helpers';
import { createProduct, updateProduct, getProduct } from '../../src/main/services/products';
import { saveParty } from '../../src/main/services/parties';
import { createPurchase } from '../../src/main/services/purchases';
import { checkout } from '../../src/main/services/sales';
import { totalStock, startStocktake, getStocktake, setStocktakeCount, completeStocktake } from '../../src/main/services/inventory';
import { MIGRATIONS } from '../../src/main/db/schema';
import { AppError } from '../../src/shared/errors';

/**
 * A supermarket sells the small unit (a can of Pepsi, a bag of chips) and buys/shelves the pack (a dozen, a carton).
 * Pepsi: 1 dozen = 12 cans; a dozen costs 300 EGP; a can sells for 30 EGP.
 */
function pepsiStore() {
  const env = setupStore();
  const can = env.unit('كانز');
  const dozen = env.unit('دستة');
  const supplier = saveParty(env.ctx, 'supplier', null, { name: 'بيبسيكو' }).id;
  const pepsi = createProduct(env.ctx, {
    name: 'بيبسي كانز', baseUnitId: can, sellPrice: egp(30), cost: egp(300) / 12,
    units: [{ unitId: dozen, factor: 12_000, isDefaultPurchase: true }],
    openingStock: { qty: 10 * 12_000 + 5_000, unitCost: egp(300) / 12 }, // 10 dozens + 5 loose cans
  }).id;
  return { env, can, dozen, supplier, pepsi };
}

describe('packaging: sell the can, buy and count the dozen', () => {
  it('the product sells by the can by default and buys by the dozen; opening 10 dozens + 5 cans = 125 cans', () => {
    const { env, can, dozen, pepsi } = pepsiStore();
    const p = getProduct(env.ctx, pepsi) as any;
    expect(p.is_weighted).toBe(0);
    expect(p.base_unit_id).toBe(can);
    expect(p.avg_cost).toBeCloseTo(2500, 6); // 300 EGP / 12 = 25 EGP a can
    const unitsBy = Object.fromEntries(p.units.map((u: any) => [u.unit_id, u]));
    expect(unitsBy[can]).toMatchObject({ factor: 1000, is_default_sale: 1, is_default_purchase: 0 });
    expect(unitsBy[dozen]).toMatchObject({ factor: 12_000, is_default_sale: 0, is_default_purchase: 1 });
    expect(totalStock(env.ctx, pepsi)).toBe(125_000);
  });

  it('buying 10 dozens adds 120 cans at 25 EGP each; selling one can takes one can at the can price', () => {
    const { env, can, dozen, supplier, pepsi } = pepsiStore();
    createPurchase(env.ctx, { supplierId: supplier, lines: [{ productId: pepsi, unitId: dozen, qty: 10_000, unitCost: egp(300) }], paid: 0 });
    expect(totalStock(env.ctx, pepsi)).toBe(245_000);
    const s = checkout(env.ctx, { cart: { lines: [{ productId: pepsi, unitId: can, qty: 1000 }] }, payments: [{ method: 'cash', amount: egp(30) }] }) as any;
    expect(s.total).toBe(egp(30));
    expect(totalStock(env.ctx, pepsi)).toBe(244_000);
    const line = env.ctx.db.prepare('SELECT base_qty, unit_cost FROM sale_items WHERE sale_id = ?').get(s.id) as any;
    expect(line.base_qty).toBe(1000);
    expect(line.unit_cost).toBeCloseTo(2500, 6);
  });

  it('stocktake shows the dozen and counts "10 dozens + 5 cans"', () => {
    const { env, pepsi } = pepsiStore();
    const st = startStocktake(env.ctx, {}) as any;
    const row = getStocktake(env.ctx, st.id).items.find((i: any) => i.product_id === pepsi);
    expect(row).toMatchObject({ pack_factor: 12_000, pack_symbol: 'دستة', unit_symbol: 'كانز', system_qty: 125_000 });
    setStocktakeCount(env.ctx, st.id, pepsi, 10 * 12_000 + 3_000); // 2 cans missing
    completeStocktake(env.ctx, st.id);
    expect(totalStock(env.ctx, pepsi)).toBe(123_000);
  });

  it('a product sold by count is never weighed, even if the form sends "sold by weight"', () => {
    const env = setupStore();
    const dozen = env.unit('دستة');
    const id = createProduct(env.ctx, { name: 'بيبسي دستة', baseUnitId: dozen, sellPrice: egp(360), isWeighted: true }).id;
    expect((getProduct(env.ctx, id) as any).is_weighted).toBe(0);
    updateProduct(env.ctx, id, { name: 'بيبسي دستة', baseUnitId: dozen, sellPrice: egp(360), isWeighted: true });
    expect((getProduct(env.ctx, id) as any).is_weighted).toBe(0);
    // weight products stay weighed
    const cheese = createProduct(env.ctx, { name: 'جبنة', baseUnitId: env.unit('كيلو'), sellPrice: egp(180) }).id;
    expect((getProduct(env.ctx, cheese) as any).is_weighted).toBe(1);
  });

  it('a gram (or ml) unit cannot be attached to a product sold by count', () => {
    const env = setupStore();
    const err = (() => { try { createProduct(env.ctx, { name: 'بيبسي', baseUnitId: env.unit('دستة'), sellPrice: egp(360), units: [{ unitId: env.unit('جرام'), factor: 1 }] }); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('VALIDATION');
    expect(String((err as AppError).params?.detail)).toContain('جرام');
    // a carton of a kilo product is fine (a carton holds 10 kg)
    expect(() => createProduct(env.ctx, { name: 'أرز', baseUnitId: env.unit('كيلو'), sellPrice: egp(40), units: [{ unitId: env.unit('كرتونة'), factor: 10_000 }] })).not.toThrow();
  });

  it('migration v4 repairs products the old form saved as "dozen, sold by weight, with a gram unit"', () => {
    const env = setupStore();
    const db = env.ctx.db;
    const dozen = env.unit('دستة');
    const gram = env.unit('جرام');
    const id = createProduct(env.ctx, { name: 'بيبسي', baseUnitId: dozen, sellPrice: egp(360) }).id;
    const cheese = createProduct(env.ctx, { name: 'جبنة', baseUnitId: env.unit('كيلو'), sellPrice: egp(180), units: [{ unitId: gram, factor: 1 }] }).id;
    // the broken state the old form produced
    db.prepare('UPDATE products SET is_weighted = 1 WHERE id = ?').run(id);
    db.prepare('INSERT INTO product_units(product_id, unit_id, factor) VALUES (?, ?, 1)').run(id, gram);
    db.exec(MIGRATIONS[3]);
    expect((getProduct(env.ctx, id) as any).is_weighted).toBe(0);
    expect((getProduct(env.ctx, id) as any).units.map((u: any) => u.unit_id)).toEqual([dozen]);
    // a real weight product keeps its flag and its gram unit
    const c = getProduct(env.ctx, cheese) as any;
    expect(c.is_weighted).toBe(1);
    expect(c.units.map((u: any) => u.unit_id)).toContain(gram);
  });
});
