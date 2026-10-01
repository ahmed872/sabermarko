import { describe, it, expect } from 'vitest';
import { setupStore, addProduct, egp, asRole, approverCtx } from './helpers';
import { checkout, createReturn, voidSale, holdSale, listHeld, getHeld, quoteCart, createQuotation, getSale } from '../../src/main/services/sales';
import { totalStock } from '../../src/main/services/inventory';
import { closeShift, currentShift, expectedCash, cashInOut, getShiftSummary, openShift } from '../../src/main/services/shifts';
import { createExpense } from '../../src/main/services/expenses';
import { saveParty, recordPayment, getParty } from '../../src/main/services/parties';
import { createPurchase, createPurchaseReturn, savePurchaseOrder, poReceiveDraft, getPurchaseOrder } from '../../src/main/services/purchases';
import { financialSummary, closeDay, dayClosingPreview, cashierPerformance } from '../../src/main/services/reports';
import { savePromotion } from '../../src/main/services/pricing';
import { setSettingRaw } from '../../src/main/services/context';

const cash = (amount: number) => [{ method: 'cash' as const, amount }];

describe('sales', () => {
  it('handles quantity, line discount, invoice discount, payment and change', () => {
    const env = setupStore();
    const p = env.unit('قطعة');
    const a = addProduct(env, { name: 'A', price: 10, cost: 6, qty: 100 });
    const b = addProduct(env, { name: 'B', price: 20, cost: 12, qty: 100 });
    const s = checkout(env.ctx, {
      cart: {
        lines: [{ productId: a, unitId: p, qty: 3000, discount: { type: 'amount', value: egp(2) } }, { productId: b, unitId: p, qty: 2000 }],
        invoiceDiscount: { type: 'percent', value: 10 },
      },
      payments: cash(egp(100)),
    });
    // gross 30 + 40 = 70; line discount 2 -> 68; invoice 10% = 6.8 -> 61.2
    expect(s.subtotal).toBe(egp(70));
    expect(s.total).toBe(egp(61.2));
    expect(s.change_due).toBe(egp(38.8));
    expect(s.items.reduce((x: number, i: any) => x + i.total, 0)).toBe(s.total); // allocation sums exactly
    expect(s.cogs).toBe(egp(3 * 6 + 2 * 12));
    const f = financialSummary(env.ctx, s.business_date, s.business_date);
    expect(f.netRevenue).toBe(egp(61.2));
    expect(f.grossProfit).toBe(egp(61.2 - 42));
    expect(f.discounts).toBe(egp(8.8));
  });

  it('rejects underpayment for walk-in customers and change from card payments', () => {
    const env = setupStore();
    const a = addProduct(env, { name: 'A', price: 10, qty: 10 });
    const lines = [{ productId: a, unitId: env.unit('قطعة'), qty: 1000 }];
    expect(() => checkout(env.ctx, { cart: { lines }, payments: cash(egp(5)) })).toThrow('PAYMENT_INSUFFICIENT');
    expect(() => checkout(env.ctx, { cart: { lines }, payments: [{ method: 'card', amount: egp(20) }] })).toThrow('OVERPAID_NON_CASH');
    const split = checkout(env.ctx, { cart: { lines }, payments: [{ method: 'card', amount: egp(4) }, { method: 'cash', amount: egp(10) }] });
    expect(split.change_due).toBe(egp(4));
    expect(split.payments).toEqual(expect.arrayContaining([{ method: 'card', amount: egp(4) }, { method: 'cash', amount: egp(6) }]));
  });

  it('a failed checkout leaves nothing behind (atomicity)', () => {
    const env = setupStore({ settings: { 'sales.allowNegativeStock': false } });
    const cashier = asRole(env, 'cashier', { shift: true });
    const a = addProduct(env, { name: 'A', price: 10, qty: 5 });
    const b = addProduct(env, { name: 'B', price: 10, qty: 1 });
    const p = env.unit('قطعة');
    const before = expectedCash(cashier, currentShift(cashier)!.id);
    expect(() => checkout(cashier, { cart: { lines: [{ productId: a, unitId: p, qty: 2000 }, { productId: b, unitId: p, qty: 3000 }] }, payments: cash(egp(50)) })).toThrow('INSUFFICIENT_STOCK');
    expect(totalStock(env.ctx, a)).toBe(5000);
    expect((env.ctx.db.prepare('SELECT COUNT(*) AS n FROM sales').get() as any).n).toBe(0);
    expect(expectedCash(cashier, currentShift(cashier)!.id)).toBe(before);
  });

  it('cashier needs approval for large discounts and price overrides', () => {
    const env = setupStore();
    const cashier = asRole(env, 'cashier', { shift: true });
    const a = addProduct(env, { name: 'A', price: 100, cost: 50, qty: 10 });
    const p = env.unit('قطعة');
    // 5% within the 10% default threshold -> allowed
    checkout(cashier, { cart: { lines: [{ productId: a, unitId: p, qty: 1000 }], invoiceDiscount: { type: 'percent', value: 5 } }, payments: cash(egp(95)) });
    expect(() => checkout(cashier, { cart: { lines: [{ productId: a, unitId: p, qty: 1000 }], invoiceDiscount: { type: 'percent', value: 30 } }, payments: cash(egp(70)) })).toThrow('APPROVAL_REQUIRED');
    expect(() => checkout(cashier, { cart: { lines: [{ productId: a, unitId: p, qty: 1000, unitPrice: egp(60) }] }, payments: cash(egp(60)) })).toThrow('APPROVAL_REQUIRED');
    const ok = checkout(approverCtx(env, cashier), { cart: { lines: [{ productId: a, unitId: p, qty: 1000 }], invoiceDiscount: { type: 'percent', value: 30 } }, payments: cash(egp(70)) });
    expect(ok.approved_by).toBe(env.ctx.user!.id);
    const audit = env.ctx.db.prepare(`SELECT * FROM audit_log WHERE action = 'sale.discount' ORDER BY id DESC LIMIT 1`).get() as any;
    expect(audit.approved_by).toBe(env.ctx.user!.id);
    expect(audit.user_id).toBe(cashier.user!.id);
  });

  it('promotions: bundle price and buy-3-get-1 reduce revenue but not stock or cost', () => {
    const env = setupStore({ settings: { 'features.promotions': true } });
    const p = env.unit('قطعة');
    const bisc = addProduct(env, { name: 'بسكويت', price: 15, cost: 9, qty: 100 });
    const juice = addProduct(env, { name: 'عصير', price: 10, cost: 6, qty: 100 });
    savePromotion(env.ctx, null, { name: '2 بـ 25', type: 'bundle', productId: bisc, minQty: 2000, value: egp(25) });
    savePromotion(env.ctx, null, { name: '3+1', type: 'bxgy', productId: juice, minQty: 3000, getQty: 1000, value: 0 });
    const q = quoteCart(env.ctx, { lines: [{ productId: bisc, unitId: p, qty: 5000 }, { productId: juice, unitId: p, qty: 4000 }] });
    // biscuits: 5 pcs = 75; 2 bundles save 2x5 = 10 -> 65 ; juice: 4 = 40, one free -> 30
    expect(q.lines[0].total).toBe(egp(65));
    expect(q.lines[1].total).toBe(egp(30));
    const s = checkout(env.ctx, { cart: { lines: [{ productId: bisc, unitId: p, qty: 5000 }, { productId: juice, unitId: p, qty: 4000 }] }, payments: cash(egp(95)) });
    expect(totalStock(env.ctx, juice)).toBe(96_000); // free unit still leaves stock
    expect(s.cogs).toBe(egp(5 * 9 + 4 * 6));
  });

  it('tax-inclusive and tax-exclusive pricing', () => {
    const env = setupStore({ settings: { 'features.tax': true, 'tax.rate': 14, 'tax.inclusive': true } });
    const p = env.unit('قطعة');
    const a = addProduct(env, { name: 'A', price: 114, qty: 10 });
    const inc = quoteCart(env.ctx, { lines: [{ productId: a, unitId: p, qty: 1000 }] });
    expect(inc.total).toBe(egp(114));
    expect(inc.taxTotal).toBe(egp(14));
    expect(inc.netRevenue).toBe(egp(100));
    setSettingRaw(env.ctx.db, 'tax.inclusive', false);
    const exc = quoteCart(env.ctx, { lines: [{ productId: a, unitId: p, qty: 1000 }] });
    expect(exc.total).toBe(egp(129.96));
    expect(exc.netRevenue).toBe(egp(114));
  });

  it('held sales and quotations do not touch stock or cash', () => {
    const env = setupStore({ settings: { 'features.quotations': true } });
    const p = env.unit('قطعة');
    const a = addProduct(env, { name: 'A', price: 10, qty: 10 });
    const shift = currentShift(env.ctx)!;
    const h = holdSale(env.ctx, { cart: { lines: [{ productId: a, unitId: p, qty: 2000 }] }, label: 'عميل رجع' });
    createQuotation(env.ctx, { cart: { lines: [{ productId: a, unitId: p, qty: 5000 }] }, customerName: 'شركة' });
    expect(totalStock(env.ctx, a)).toBe(10_000);
    expect(expectedCash(env.ctx, shift.id)).toBe(50_000);
    expect(listHeld(env.ctx)).toHaveLength(1);
    const cart = getHeld(env.ctx, h.id).cart;
    checkout(env.ctx, { cart, payments: cash(egp(20)), heldId: h.id });
    expect(listHeld(env.ctx)).toHaveLength(0);
    expect(totalStock(env.ctx, a)).toBe(8_000);
  });
});

describe('returns & voids (spec §33)', () => {
  it('partial returns reverse revenue, cost, stock and cash proportionally, and cannot exceed sold qty', () => {
    const env = setupStore();
    const p = env.unit('قطعة');
    const a = addProduct(env, { name: 'A', price: 10, cost: 7, qty: 10 });
    const s = checkout(env.ctx, { cart: { lines: [{ productId: a, unitId: p, qty: 3000 }], invoiceDiscount: { type: 'amount', value: egp(1) } }, payments: cash(egp(29)) });
    const item = s.items[0];
    const r1 = createReturn(env.ctx, { saleId: s.id, items: [{ saleItemId: item.id, qty: 1000 }], refundMethod: 'cash' });
    expect(r1.total).toBe(egp(9.67));
    const r2 = createReturn(env.ctx, { saleId: s.id, items: [{ saleItemId: item.id, qty: 2000 }], refundMethod: 'cash' });
    expect(r1.total + r2.total).toBe(s.total); // final return takes the exact remainder
    expect(() => createReturn(env.ctx, { saleId: s.id, items: [{ saleItemId: item.id, qty: 1000 }], refundMethod: 'cash' })).toThrow('RETURN_QTY_EXCEEDED');
    expect(totalStock(env.ctx, a)).toBe(10_000);
    const f = financialSummary(env.ctx, s.business_date, s.business_date);
    expect(f.netRevenue).toBe(0);
    expect(f.cogs).toBe(0);
    expect(f.grossProfit).toBe(0);
    expect(expectedCash(env.ctx, currentShift(env.ctx)!.id)).toBe(50_000);
  });

  it('a damaged return refunds the customer but keeps the cost as a loss', () => {
    const env = setupStore();
    const p = env.unit('قطعة');
    const a = addProduct(env, { name: 'A', price: 10, cost: 7, qty: 10 });
    const s = checkout(env.ctx, { cart: { lines: [{ productId: a, unitId: p, qty: 1000 }] }, payments: cash(egp(10)) });
    createReturn(env.ctx, { saleId: s.id, items: [{ saleItemId: s.items[0].id, qty: 1000, restock: false }], refundMethod: 'cash' });
    expect(totalStock(env.ctx, a)).toBe(9_000);
    const f = financialSummary(env.ctx, s.business_date, s.business_date);
    expect(f.netRevenue).toBe(0);
    expect(f.grossProfit).toBe(-egp(7));
  });

  it('void reverses everything; only same day; cashier needs approval', () => {
    const env = setupStore();
    const cashier = asRole(env, 'cashier', { shift: true });
    const p = env.unit('قطعة');
    const a = addProduct(env, { name: 'A', price: 10, cost: 7, qty: 10 });
    const s = checkout(cashier, { cart: { lines: [{ productId: a, unitId: p, qty: 2000 }] }, payments: cash(egp(20)) });
    expect(() => voidSale(cashier, { saleId: s.id, reason: 'خطأ' })).toThrow('APPROVAL_REQUIRED');
    voidSale(approverCtx(env, cashier), { saleId: s.id, reason: 'خطأ في الإدخال' });
    expect(totalStock(env.ctx, a)).toBe(10_000);
    expect(expectedCash(cashier, currentShift(cashier)!.id)).toBe(0);
    expect(financialSummary(env.ctx, s.business_date, s.business_date).invoices).toBe(0);
    expect(() => voidSale(env.ctx, { saleId: s.id, reason: 'x' })).toThrow('SALE_ALREADY_VOIDED');
    const s2 = checkout(env.ctx, { cart: { lines: [{ productId: a, unitId: p, qty: 1000 }] }, payments: cash(egp(10)) });
    env.clock.t = new Date(env.clock.t.getTime() + 86_400_000);
    expect(() => voidSale(env.ctx, { saleId: s2.id, reason: 'x' })).toThrow('VOID_NOT_TODAY');
  });
});

describe('customers & credit (spec §31/32)', () => {
  it('credit sale, payment and return update the customer ledger', () => {
    const env = setupStore();
    const p = env.unit('قطعة');
    const a = addProduct(env, { name: 'A', price: 50, qty: 10 });
    const c = saveParty(env.ctx, 'customer', null, { name: 'أبو محمد', phone: '0100', creditLimit: egp(200) }).id;
    const s = checkout(env.ctx, { cart: { customerId: c, lines: [{ productId: a, unitId: p, qty: 3000 }] }, payments: [{ method: 'cash', amount: egp(50) }] });
    expect(s.credit_amount).toBe(egp(100));
    expect(getParty(env.ctx, 'customer', c).balance).toBe(egp(100));
    // over the limit
    expect(() => checkout(env.ctx, { cart: { customerId: c, lines: [{ productId: a, unitId: p, qty: 3000 }] }, payments: [] })).toThrow('CREDIT_LIMIT');
    recordPayment(env.ctx, 'customer', { partyId: c, amount: egp(40) });
    expect(getParty(env.ctx, 'customer', c).balance).toBe(egp(60));
    createReturn(env.ctx, { saleId: s.id, items: [{ saleItemId: s.items[0].id, qty: 1000 }], refundMethod: 'credit' });
    const party = getParty(env.ctx, 'customer', c);
    expect(party.balance).toBe(egp(10));
    expect(party.ledger.map((l: any) => l.type)).toEqual(['return', 'payment', 'sale']);
    // collected cash lands in the drawer
    expect(expectedCash(env.ctx, currentShift(env.ctx)!.id)).toBe(50_000 + egp(50) + egp(40));
  });

  it('cashier cannot open debt without permission; credit can be disabled', () => {
    const env = setupStore();
    const cashier = asRole(env, 'cashier', { shift: true });
    const a = addProduct(env, { name: 'A', price: 50, qty: 10 });
    const c = saveParty(env.ctx, 'customer', null, { name: 'عميل' }).id;
    const cart = { customerId: c, lines: [{ productId: a, unitId: env.unit('قطعة'), qty: 1000 }] };
    expect(() => checkout(cashier, { cart, payments: [] })).toThrow('APPROVAL_REQUIRED');
    setSettingRaw(env.ctx.db, 'features.creditSales', false);
    expect(() => checkout(env.ctx, { cart, payments: [] })).toThrow('CREDIT_DISABLED');
  });
});

describe('suppliers & purchases (spec §27-30)', () => {
  it('tracks supplier debt, payments and purchase returns', () => {
    const env = setupStore();
    const p = env.unit('قطعة');
    const a = addProduct(env, { name: 'A', price: 10 });
    const sup = saveParty(env.ctx, 'supplier', null, { name: 'شركة التوريد' }).id;
    createPurchase(env.ctx, { supplierId: sup, lines: [{ productId: a, unitId: p, qty: 100_000, unitCost: egp(1000) }], paid: egp(70_000) });
    expect(getParty(env.ctx, 'supplier', sup).balance).toBe(egp(30_000));
    recordPayment(env.ctx, 'supplier', { partyId: sup, amount: egp(10_000), method: 'bank' });
    expect(getParty(env.ctx, 'supplier', sup).balance).toBe(egp(20_000));
    createPurchaseReturn(env.ctx, { supplierId: sup, lines: [{ productId: a, unitId: p, qty: 5000, unitCost: egp(1000) }], refundMethod: 'balance' });
    expect(getParty(env.ctx, 'supplier', sup).balance).toBe(egp(15_000));
    expect(totalStock(env.ctx, a)).toBe(95_000);
    expect(() => createPurchase(env.ctx, { lines: [{ productId: a, unitId: p, qty: 1000, unitCost: egp(10) }], paid: 0 })).toThrow('VALIDATION');
  });

  it('purchase orders do not change stock until received (partial receipt supported)', () => {
    const env = setupStore({ settings: { 'features.purchaseOrders': true } });
    const carton = env.unit('كرتونة');
    const bottle = env.unit('زجاجة');
    const sup = saveParty(env.ctx, 'supplier', null, { name: 'مياه' }).id;
    const water = addProduct(env, { name: 'مياه', price: 6, unit: 'زجاجة', units: [{ unit: 'كرتونة', factor: 12 }] });
    const po = savePurchaseOrder(env.ctx, null, { supplierId: sup, lines: [{ productId: water, unitId: carton, qty: 20_000, unitCost: egp(48) }] });
    expect(totalStock(env.ctx, water)).toBe(0);
    const draft = poReceiveDraft(env.ctx, po.id);
    createPurchase(env.ctx, { supplierId: sup, poId: po.id, lines: [{ ...draft.lines[0], qty: 15_000 }], paid: 0 });
    expect(totalStock(env.ctx, water)).toBe(180_000);
    expect(getPurchaseOrder(env.ctx, po.id).status).toBe('partial');
    createPurchase(env.ctx, { supplierId: sup, poId: po.id, lines: [{ ...poReceiveDraft(env.ctx, po.id).lines[0] }], paid: 0 });
    expect(getPurchaseOrder(env.ctx, po.id).status).toBe('received');
    expect(totalStock(env.ctx, water)).toBe(240_000);
    void bottle;
  });
});

describe('cash drawer & shifts (spec §34/35)', () => {
  it('expected cash = opening + cash sales − refunds − expenses − withdrawals + deposits; variance recorded', () => {
    const env = setupStore({ shift: false });
    const p = env.unit('قطعة');
    const a = addProduct(env, { name: 'A', price: 100, cost: 60, qty: 100 });
    openShift(env.ctx, { openingCash: egp(1000) });
    const s = checkout(env.ctx, { cart: { lines: [{ productId: a, unitId: p, qty: 5000 }] }, payments: cash(egp(500)) });
    checkout(env.ctx, { cart: { lines: [{ productId: a, unitId: p, qty: 1000 }] }, payments: [{ method: 'card', amount: egp(100) }] });
    createReturn(env.ctx, { saleId: s.id, items: [{ saleItemId: s.items[0].id, qty: 1000 }], refundMethod: 'cash' });
    const cat = (env.ctx.db.prepare('SELECT id FROM expense_categories LIMIT 1').get() as any).id;
    createExpense(env.ctx, { categoryId: cat, amount: egp(50), paidFromDrawer: true });
    cashInOut(env.ctx, { type: 'withdrawal', amount: egp(200), note: 'توريد' });
    cashInOut(env.ctx, { type: 'deposit', amount: egp(30), note: 'فكة' });
    const shift = currentShift(env.ctx)!;
    expect(expectedCash(env.ctx, shift.id)).toBe(egp(1000 + 500 - 100 - 50 - 200 + 30));
    const closed = closeShift(env.ctx, { countedCash: egp(1030) });
    expect(closed.variance).toBe(-egp(150));
    expect(closed.status).toBe('closed');
    expect(() => cashInOut(env.ctx, { type: 'deposit', amount: 100 })).toThrow('SHIFT_REQUIRED');
    // shift is required to sell
    expect(() => checkout(env.ctx, { cart: { lines: [{ productId: a, unitId: p, qty: 1000 }] }, payments: cash(egp(100)) })).toThrow('SHIFT_REQUIRED');
    const sum = getShiftSummary(env.ctx, shift.id);
    expect(sum.sales.count).toBe(2);
  });

  it('cannot withdraw more cash than the drawer holds; one open shift per cashier', () => {
    const env = setupStore({ shift: false });
    openShift(env.ctx, { openingCash: egp(100) });
    expect(() => openShift(env.ctx, { openingCash: 0 })).toThrow('SHIFT_ALREADY_OPEN');
    expect(() => cashInOut(env.ctx, { type: 'withdrawal', amount: egp(150) })).toThrow('CASH_INSUFFICIENT');
  });
});

describe('profit, daily closing and report integrity (spec §41-43, §92)', () => {
  it('every report agrees with the same source of truth', () => {
    const env = setupStore();
    const p = env.unit('قطعة');
    const kg = env.unit('كيلو');
    const a = addProduct(env, { name: 'A', price: 20, cost: 12, qty: 100 });
    const cheese = addProduct(env, { name: 'جبنة', price: 180, cost: 140, unit: 'كيلو', weighted: true, qty: 5 });
    const cashier = asRole(env, 'cashier', { shift: true });
    checkout(env.ctx, { cart: { lines: [{ productId: a, unitId: p, qty: 4000 }] }, payments: cash(egp(80)) });
    const s2 = checkout(cashier, { cart: { lines: [{ productId: cheese, unitId: kg, qty: 250 }, { productId: a, unitId: p, qty: 1000 }] }, payments: cash(egp(65)) });
    createReturn(env.ctx, { saleId: s2.id, items: [{ saleItemId: s2.items[1].id, qty: 1000 }], refundMethod: 'cash' });
    const cat = (env.ctx.db.prepare('SELECT id FROM expense_categories LIMIT 1').get() as any).id;
    createExpense(env.ctx, { categoryId: cat, amount: egp(10) });
    const d = s2.business_date;
    const f = financialSummary(env.ctx, d, d);
    expect(f.netSales).toBe(egp(80 + 65 - 20));
    expect(f.cogs).toBe(egp(48 + 35));
    expect(f.grossProfit).toBe(egp(125 - 83));
    expect(f.netProfit).toBe(egp(42 - 10));
    const day = dayClosingPreview(env.ctx, d);
    expect(day.summary).toEqual(f);
    const cashiers = cashierPerformance(env.ctx, d, d);
    expect(cashiers.reduce((x, c) => x + c.netSales, 0)).toBe(f.netSales);
    const closed = closeDay(env.ctx, d);
    expect(closed.summary.netProfit).toBe(f.netProfit);
    expect(() => closeDay(env.ctx, d)).toThrow('DAY_ALREADY_CLOSED');
    expect(getSale(env.ctx, s2.id).items).toHaveLength(2);
  });
});
