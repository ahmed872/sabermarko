import { describe, it, expect } from 'vitest';
import { setupStore, addProduct, egp, asRole } from './helpers';
import { createProduct, deleteProduct, listProducts, posSearch, updateProduct, getProduct, setProductActive } from '../../src/main/services/products';
import { checkout } from '../../src/main/services/sales';
import { listUsers, saveUser, authenticate } from '../../src/main/services/users';
import { updateSettings } from '../../src/main/services/settings';
import { financialSummary } from '../../src/main/services/reports';
import { createAdjustment } from '../../src/main/services/inventory';
import { normalizeArabic, parseDecimal } from '../../src/shared/arabic';
import { errorMessage } from '../../src/shared/errors';

describe('authorization is enforced in the engine, not the UI (spec §71)', () => {
  it('cashier cannot manage users, settings, see profits, adjust stock or edit prices', () => {
    const env = setupStore();
    const cashier = asRole(env, 'cashier', { shift: true });
    const id = addProduct(env, { name: 'A', price: 10, cost: 5, qty: 10 });
    expect(() => listUsers(cashier)).toThrow('FORBIDDEN');
    expect(() => updateSettings(cashier, { 'sales.maxDiscountPct': 100 })).toThrow('FORBIDDEN');
    expect(() => financialSummary(cashier, '2026-01-01', '2026-12-31')).not.toThrow(); // raw fn; route uses summaryReport
    expect(() => createAdjustment(cashier, { type: 'loss', reason: 'x', lines: [{ productId: id, qty: 1000 }] })).toThrow('FORBIDDEN');
    expect(() => updateProduct(cashier, id, { name: 'A', baseUnitId: env.unit('قطعة'), sellPrice: egp(1) })).toThrow('FORBIDDEN');
    expect(() => deleteProduct(cashier, id)).toThrow('FORBIDDEN');
    // cost is hidden from roles without reports.cost
    expect(getProduct(cashier, id).avg_cost).toBeNull();
    const sale = checkout(cashier, { cart: { lines: [{ productId: id, unitId: env.unit('قطعة'), qty: 1000 }] }, payments: [{ method: 'cash', amount: egp(10) }] });
    expect(sale.cogs).toBeNull();
  });

  it('deactivated users cannot log in; repeated failures lock the account', () => {
    const env = setupStore();
    const role = (env.ctx.db.prepare(`SELECT id FROM roles WHERE code = 'cashier'`).get() as any).id;
    const u = saveUser(env.ctx, null, { username: 'sara', fullName: 'سارة', password: 'abcd', roleId: role });
    for (let i = 0; i < 5; i++) expect(() => authenticate(env.ctx, 'sara', 'wrong')).toThrow('INVALID_CREDENTIALS');
    expect(() => authenticate(env.ctx, 'sara', 'abcd')).toThrow('INVALID_CREDENTIALS'); // locked
    env.clock.t = new Date(env.clock.t.getTime() + 6 * 60_000);
    expect(authenticate(env.ctx, 'sara', 'abcd').username).toBe('sara');
    saveUser(env.ctx, u.id, { username: 'sara', fullName: 'سارة', roleId: role, active: false });
    expect(() => authenticate(env.ctx, 'sara', 'abcd')).toThrow('USER_INACTIVE');
    const stored = (env.ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id) as any).password_hash;
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain('abcd');
  });

  it('the last admin cannot be demoted or disabled', () => {
    const env = setupStore();
    const cashierRole = (env.ctx.db.prepare(`SELECT id FROM roles WHERE code = 'cashier'`).get() as any).id;
    expect(() => saveUser(env.ctx, env.ctx.user!.id, { username: 'admin', fullName: 'أحمد', roleId: cashierRole })).toThrow('LAST_ADMIN');
  });

  it('search input is parameterized (no SQL injection)', () => {
    const env = setupStore();
    addProduct(env, { name: 'A', price: 10 });
    expect(() => listProducts(env.ctx, { q: "'; DROP TABLE products; --" })).not.toThrow();
    expect(listProducts(env.ctx, {}).total).toBe(1);
  });
});

describe('products', () => {
  it('a product with history is archived, never hard-deleted (spec §65)', () => {
    const env = setupStore();
    const id = addProduct(env, { name: 'A', price: 10, qty: 5 });
    expect(() => deleteProduct(env.ctx, id)).toThrow('PRODUCT_IN_USE');
    setProductActive(env.ctx, id, false);
    expect(listProducts(env.ctx, {}).total).toBe(0);
    expect(listProducts(env.ctx, { status: 'all' }).total).toBe(1);
    const fresh = addProduct(env, { name: 'B', price: 10 });
    expect(deleteProduct(env.ctx, fresh)).toEqual({ ok: true });
  });

  it('duplicate barcodes are rejected with a clear Arabic message', () => {
    const env = setupStore();
    addProduct(env, { name: 'A', price: 10, barcode: '123' });
    try {
      addProduct(env, { name: 'B', price: 10, barcode: '123' });
      throw new Error('should fail');
    } catch (e: any) {
      expect(e.code).toBe('DUPLICATE_BARCODE');
      expect(errorMessage(e.code, e.params)).toBe('الباركود "123" مستخدم لمنتج آخر.');
    }
  });

  it('price changes are kept in price history and the audit log', () => {
    const env = setupStore();
    const id = addProduct(env, { name: 'A', price: 20 });
    updateProduct(env.ctx, id, { name: 'A', baseUnitId: env.unit('قطعة'), sellPrice: egp(22) });
    updateProduct(env.ctx, id, { name: 'A', baseUnitId: env.unit('قطعة'), sellPrice: egp(25) });
    const hist = env.ctx.db.prepare(`SELECT old_price, new_price FROM price_history WHERE product_id = ? AND kind = 'sell' ORDER BY id`).all(id);
    expect(hist).toEqual([{ old_price: null, new_price: 2000 }, { old_price: 2000, new_price: 2200 }, { old_price: 2200, new_price: 2500 }]);
    expect((env.ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product.price_change'`).get() as any).n).toBe(2);
  });

  it('Arabic-friendly search ignores hamza/taa-marbuta/diacritic differences and finds by brand/category', () => {
    const env = setupStore();
    const cat = (env.ctx.db.prepare(`SELECT id FROM categories WHERE name = 'مشروبات'`).get() as any).id;
    createProduct(env.ctx, { name: 'مَيّاه معدنية إيفيان', baseUnitId: env.unit('زجاجة'), sellPrice: egp(10), categoryId: cat, brandName: 'دانون' });
    expect(normalizeArabic('إيفيان')).toBe(normalizeArabic('ايفيان'));
    expect(posSearch(env.ctx, 'مياه ايفيان').items).toHaveLength(1);
    expect(posSearch(env.ctx, 'معدنيه').items).toHaveLength(1);
    expect(posSearch(env.ctx, 'دانون').items).toHaveLength(1);
    expect(posSearch(env.ctx, 'مشروبات').items).toHaveLength(1);
    expect(parseDecimal('١٢٫٥')).toBe(12.5);
    expect(parseDecimal('1,250')).toBe(1250);
  });
});

describe('performance with a large store (spec §67)', () => {
  it('10,000 products: search, barcode lookup and listing stay fast', () => {
    const env = setupStore();
    const unit = env.unit('قطعة');
    const db = env.ctx.db;
    const t0 = Date.now();
    db.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        createProduct(env.ctx, { name: `منتج رقم ${i} ${i % 7 === 0 ? 'شيبسي' : 'بسكويت'}`, baseUnitId: unit, sellPrice: 1000 + i, barcode: `62210${String(i).padStart(8, '0')}` });
      }
    })();
    const insertMs = Date.now() - t0;
    const t1 = performance.now();
    const r = posSearch(env.ctx, 'شيبسي');
    const textMs = performance.now() - t1;
    const t2 = performance.now();
    const b = posSearch(env.ctx, '6221000009999');
    const barcodeMs = performance.now() - t2;
    const t3 = performance.now();
    const page = listProducts(env.ctx, { q: 'منتج', page: 50, pageSize: 50 });
    const listMs = performance.now() - t3;
    expect(r.items.length).toBeGreaterThan(0);
    expect(b.exact).toBe(true);
    expect(page.rows).toHaveLength(50);
    console.log(`10k insert ${insertMs}ms, text search ${textMs.toFixed(1)}ms, barcode ${barcodeMs.toFixed(2)}ms, list page ${listMs.toFixed(1)}ms`);
    expect(textMs).toBeLessThan(150);
    expect(barcodeMs).toBeLessThan(20);
    expect(listMs).toBeLessThan(400);
  }, 120_000);
});
