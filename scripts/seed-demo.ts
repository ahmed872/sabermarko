/**
 * DEMO MODE generator — deliberately separate from the app.
 * Creates a realistic store database (60 days of history) at the given path,
 * for sales demos, screenshots and end-to-end tests. Production installs
 * never run this; a new store always starts clean.
 *
 *   node dist/tools/seed-demo.js <userDataDir>
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, migrate } from '../src/main/db/connection';
import { seedSystemData } from '../src/main/db/seed';
import type { Ctx } from '../src/main/services/context';
import { setSettingRaw } from '../src/main/services/context';
import { completeSetup } from '../src/main/services/settings';
import { login, saveUser } from '../src/main/services/users';
import { createProduct } from '../src/main/services/products';
import { saveParty, recordPayment } from '../src/main/services/parties';
import { createPurchase } from '../src/main/services/purchases';
import { checkout, quoteCart } from '../src/main/services/sales';
import { closeShift, openShift } from '../src/main/services/shifts';
import { createExpense } from '../src/main/services/expenses';
import { generateSuggestions } from '../src/main/services/recommendations';

const dir = process.argv[2];
if (!dir) { console.error('usage: seed-demo <userDataDir>'); process.exit(1); }
mkdirSync(join(dir, 'data'), { recursive: true });
const db = openDatabase(join(dir, 'data', 'store.db'));
migrate(db);
seedSystemData(db);

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const egp = (v: number) => Math.round(v * 100);

const DAY = 86_400_000;
const end = new Date(Date.now() - 3600_000); // never in the future (clock-tamper protection)
const clock = { t: new Date(end.getTime() - 60 * DAY) };
const ctx: Ctx = { db, user: null, now: () => clock.t };
completeSetup(ctx, {
  storeName: 'سوبر ماركت البركة', phone: '01012345678', address: 'شارع الجمهورية — المنصورة', currencyCode: 'EGP', currencySymbol: 'ج.م',
  adminName: 'الحاج محمود', adminUsername: 'admin', adminPassword: '1234', starterCategories: true, mode: 'advanced', printType: 'thermal80',
});
ctx.user = login(ctx, 'admin', '1234');
setSettingRaw(db, 'features.expiry', true);
const unit = (n: string) => (db.prepare('SELECT id FROM units WHERE name = ?').get(n) as { id: number }).id;
const cat = (n: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(n) as { id: number }).id;
const cashierRole = (db.prepare(`SELECT id FROM roles WHERE code = 'cashier'`).get() as { id: number }).id;
saveUser(ctx, null, { username: 'sara', fullName: 'سارة (كاشير)', password: '1234', roleId: cashierRole });

const sup = {
  pepsico: saveParty(ctx, 'supplier', null, { name: 'بيبسيكو — التوزيع', company: 'PepsiCo', phone: '01100000001', leadTimeDays: 2 }).id,
  dairy: saveParty(ctx, 'supplier', null, { name: 'جهينة للألبان', phone: '01100000002', leadTimeDays: 1 }).id,
  grocery: saveParty(ctx, 'supplier', null, { name: 'مخازن النور للجملة', phone: '01100000003', leadTimeDays: 3 }).id,
};
const cust = [
  saveParty(ctx, 'customer', null, { name: 'أم أحمد', phone: '01222222221', creditLimit: egp(1500) }).id,
  saveParty(ctx, 'customer', null, { name: 'الأستاذ كريم', phone: '01222222222', creditLimit: egp(3000) }).id,
];

const piece = unit('قطعة'), bag = unit('كيس'), carton = unit('كرتونة'), bottle = unit('زجاجة'), kilo = unit('كيلو'), gram = unit('جرام'), box = unit('علبة');
type P = { id: number; daily: number; supplier: number; carton?: number; unit: number; cost: number; weighted?: boolean };
const products: Record<string, P> = {};
const add = (key: string, d: { name: string; category: string; price: number; cost: number; unit: number; carton?: number; daily: number; supplier: number; group?: string; variant?: string; weighted?: boolean; brand?: string; fav?: boolean; barcode?: string; expiry?: boolean; min?: number }) => {
  const id = createProduct(ctx, {
    name: d.name, categoryId: cat(d.category), baseUnitId: d.unit, sellPrice: egp(d.price), cost: egp(d.cost), brandName: d.brand ?? null, groupName: d.group ?? null, variantName: d.variant ?? null,
    isWeighted: !!d.weighted, isFavorite: !!d.fav, barcode: d.barcode ?? null, trackExpiry: !!d.expiry, minStock: (d.min ?? 0) * 1000,
    units: [...(d.carton ? [{ unitId: carton, factor: d.carton * 1000, isDefaultPurchase: true }] : []), ...(d.weighted ? [{ unitId: gram, factor: 1 }] : [])],
  }).id;
  products[key] = { id, daily: d.daily, supplier: d.supplier, carton: d.carton, unit: d.unit, cost: d.cost, weighted: d.weighted };
};
add('coke330', { name: 'كوكاكولا', variant: '330 مل', group: 'كوكاكولا', category: 'مشروبات', price: 15, cost: 12, unit: bottle, carton: 24, daily: 16, supplier: sup.grocery, brand: 'كوكاكولا', fav: true, barcode: '5449000000996', min: 24 });
add('coke1l', { name: 'كوكاكولا', variant: '1 لتر', group: 'كوكاكولا', category: 'مشروبات', price: 28, cost: 23, unit: bottle, carton: 12, daily: 5, supplier: sup.grocery, brand: 'كوكاكولا', fav: true, min: 12 });
add('pepsi', { name: 'بيبسي 330 مل', category: 'مشروبات', price: 14, cost: 11.25, unit: bottle, carton: 24, daily: 12, supplier: sup.pepsico, brand: 'بيبسي', fav: true, min: 24 });
add('water', { name: 'مياه نستله 600 مل', category: 'مشروبات', price: 7, cost: 5, unit: bottle, carton: 12, daily: 22, supplier: sup.grocery, fav: true, min: 24 });
add('juice', { name: 'عصير جهينة مانجو', category: 'مشروبات', price: 12, cost: 9.5, unit: box, carton: 24, daily: 6, supplier: sup.dairy, expiry: true, min: 12 });
add('chipsA', { name: 'شيبسي طماطم', category: 'شيبسي وسناكس', price: 10, cost: 7.5, unit: bag, carton: 30, daily: 14, supplier: sup.pepsico, brand: 'شيبسي', fav: true, barcode: '6221031490018', min: 30 });
add('chipsB', { name: 'شيبسي جبنة كبير', category: 'شيبسي وسناكس', price: 15, cost: 11.5, unit: bag, carton: 24, daily: 8, supplier: sup.pepsico, brand: 'شيبسي', fav: true, min: 24 });
add('doritos', { name: 'دوريتوس سويت شيلي', category: 'شيبسي وسناكس', price: 20, cost: 12, unit: bag, carton: 20, daily: 1, supplier: sup.pepsico, brand: 'دوريتوس' });
add('pretzel', { name: 'بريتزل ملح', category: 'شيبسي وسناكس', price: 8, cost: 7.3, unit: bag, carton: 40, daily: 0.6, supplier: sup.grocery });
add('ice1', { name: 'آيس كريم فانيليا', category: 'مجمدات', price: 20, cost: 15, unit: piece, carton: 24, daily: 6, supplier: sup.dairy, fav: true });
add('ice2', { name: 'آيس كريم شوكولاتة', category: 'مجمدات', price: 25, cost: 19, unit: piece, carton: 24, daily: 4, supplier: sup.dairy });
add('tuna', { name: 'تونة دولفين 185 جم', category: 'معلبات', price: 45, cost: 38, unit: box, carton: 48, daily: 3, supplier: sup.grocery, brand: 'دولفين', fav: true, min: 12 });
add('beans', { name: 'فول مدمس أمريكانا', category: 'معلبات', price: 18, cost: 14, unit: box, carton: 24, daily: 4, supplier: sup.grocery });
add('cheese', { name: 'جبنة رومي', category: 'منتجات بالوزن', price: 180, cost: 140, unit: kilo, daily: 1.4, supplier: sup.dairy, weighted: true, fav: true });
add('luncheon', { name: 'لانشون حلواني', category: 'منتجات بالوزن', price: 160, cost: 120, unit: kilo, daily: 0.9, supplier: sup.dairy, weighted: true, fav: true });
add('olives', { name: 'زيتون أسود', category: 'منتجات بالوزن', price: 90, cost: 60, unit: kilo, daily: 0.3, supplier: sup.grocery, weighted: true });
add('milk', { name: 'لبن جهينة 1 لتر', category: 'ألبان وأجبان', price: 38, cost: 33, unit: box, carton: 12, daily: 9, supplier: sup.dairy, expiry: true, fav: true, min: 12 });
add('yogurt', { name: 'زبادي جهينة', category: 'ألبان وأجبان', price: 9, cost: 7, unit: piece, carton: 24, daily: 7, supplier: sup.dairy, expiry: true });
add('biscuit', { name: 'بسكويت ماري', category: 'حلويات وشوكولاتة', price: 5, cost: 3.6, unit: piece, carton: 48, daily: 10, supplier: sup.grocery });
add('choco', { name: 'شوكولاتة كادبوري', category: 'حلويات وشوكولاتة', price: 25, cost: 18, unit: piece, carton: 24, daily: 3, supplier: sup.grocery });
add('wafer', { name: 'ويفر بالبندق', category: 'حلويات وشوكولاتة', price: 12, cost: 7, unit: piece, carton: 36, daily: 0.4, supplier: sup.grocery });
add('soap', { name: 'صابون لوكس', category: 'منظفات', price: 22, cost: 17, unit: piece, carton: 48, daily: 1.2, supplier: sup.grocery });
add('detergent', { name: 'مسحوق أريال 1 كجم', category: 'منظفات', price: 95, cost: 80, unit: bag, carton: 10, daily: 1, supplier: sup.grocery });
add('rice', { name: 'أرز الضحى 1 كجم', category: 'بقالة جافة', price: 38, cost: 33, unit: bag, carton: 10, daily: 4, supplier: sup.grocery, min: 10 });
add('sugar', { name: 'سكر 1 كجم', category: 'بقالة جافة', price: 35, cost: 31, unit: bag, carton: 10, daily: 5, supplier: sup.grocery, min: 10 });
add('tea', { name: 'شاي العروسة 250 جم', category: 'بقالة جافة', price: 42, cost: 34, unit: box, carton: 24, daily: 3, supplier: sup.grocery });
add('oil', { name: 'زيت عافية 800 مل', category: 'بقالة جافة', price: 85, cost: 74, unit: bottle, carton: 12, daily: 1.5, supplier: sup.grocery });
add('shampoo', { name: 'شامبو هيد آند شولدرز', category: 'عناية شخصية', price: 120, cost: 88, unit: bottle, carton: 12, daily: 0.15, supplier: sup.grocery });

const P = (k: string) => products[k];
// opening purchases (with an oversized order of two items to create excess stock)
const buy = (k: string, cartons: number, expiry?: string) => {
  const p = P(k);
  if (p.weighted) {
    createPurchase(ctx, { supplierId: p.supplier, lines: [{ productId: p.id, unitId: kilo, qty: cartons * 1000, unitCost: egp(p.cost) }], paid: egp(p.cost * cartons) });
    return;
  }
  createPurchase(ctx, { supplierId: p.supplier, lines: [{ productId: p.id, unitId: carton, qty: cartons * 1000, unitCost: egp(p.cost * p.carton!), expiryDate: expiry ?? null }], paid: egp(p.cost * p.carton! * cartons * 0.6) });
};
const inDays = (n: number) => { const d = new Date(end.getTime() + n * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
for (const k of Object.keys(products)) {
  const p = P(k);
  if (p.weighted) { buy(k, k === 'olives' ? 15 : 25); continue; }
  const needed = Math.max(1, Math.ceil((p.daily * 35) / p.carton!));
  const exp = ['milk', 'yogurt', 'juice'].includes(k) ? inDays(k === 'yogurt' ? 9 : 40) : undefined;
  buy(k, k === 'doritos' ? 5 : k === 'pretzel' ? 4 : k === 'wafer' ? 3 : needed, exp);
}
const cashier = { ...ctx, user: login(ctx, 'sara', '1234') };
const cats = Object.keys(products);
const cat2 = (db.prepare('SELECT id FROM expense_categories WHERE name = ?').get('كهرباء') as { id: number }).id;
const rent = (db.prepare('SELECT id FROM expense_categories WHERE name = ?').get('إيجار') as { id: number }).id;

for (let day = 0; day < 60; day++) {
  clock.t = new Date(end.getTime() - (60 - day) * DAY);
  const actor = day % 2 === 0 ? ctx : cashier;
  openShift(actor, { openingCash: egp(500) });
  const invoices = 35 + Math.floor(rnd() * 25);
  const remaining: Record<string, number> = Object.fromEntries(cats.map((k) => [k, P(k).daily * (0.7 + rnd() * 0.6)]));
  for (let i = 0; i < invoices; i++) {
    clock.t = new Date(clock.t.getTime() + 12 * 60_000);
    const lines: { productId: number; unitId: number; qty: number }[] = [];
    const n = 1 + Math.floor(rnd() * 4);
    for (let j = 0; j < n; j++) {
      const k = pick(cats);
      if (remaining[k] <= 0) continue;
      const p = P(k);
      if (lines.some((l) => l.productId === p.id)) continue;
      if (p.weighted) { const g = pick([125, 250, 250, 500]); remaining[k] -= g / 1000; lines.push({ productId: p.id, unitId: gram, qty: g * 1000 }); }
      else { const q = Math.min(Math.max(1, Math.round(rnd() * 3)), Math.ceil(remaining[k])); remaining[k] -= q; lines.push({ productId: p.id, unitId: p.unit, qty: q * 1000 }); }
    }
    // tea and sugar are often bought together
    if (lines.some((l) => l.productId === P('tea').id) && rnd() < 0.6 && !lines.some((l) => l.productId === P('sugar').id)) lines.push({ productId: P('sugar').id, unitId: bag, qty: 1000 });
    if (!lines.length) continue;
    const q = quoteCart(actor, { lines });
    const credit = rnd() < 0.03;
    try {
      if (credit) checkout(actor, { cart: { lines, customerId: pick(cust) }, payments: [] });
      else checkout(actor, { cart: { lines }, payments: [{ method: rnd() < 0.15 ? 'card' : 'cash', amount: rnd() < 0.15 ? q.total : Math.ceil(q.total / 5000) * 5000 }] });
    } catch { /* credit limit etc. */ }
  }
  if (day % 7 === 3) for (const k of cats) {
    const p = P(k);
    const stock = (db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM product_stock WHERE product_id = ?').get(p.id) as { q: number }).q / 1000;
    if (['doritos', 'pretzel', 'wafer', 'shampoo'].includes(k)) continue;
    if (stock < p.daily * 10) buy(k, p.weighted ? 10 : Math.max(1, Math.ceil((p.daily * 14) / p.carton!)), ['milk', 'yogurt', 'juice'].includes(k) ? inDays(k === 'yogurt' ? 9 : 30) : undefined);
  }
  if (day === 5) createExpense(ctx, { categoryId: rent, amount: egp(6000), note: 'إيجار الشهر' });
  if (day === 12 || day === 42) createExpense(ctx, { categoryId: cat2, amount: egp(850), note: 'فاتورة الكهرباء' });
  if (day === 30) recordPayment(ctx, 'customer', { partyId: cust[0], amount: egp(100) });
  clock.t = new Date(clock.t.getTime() + 30 * 60_000);
  const expected = (db.prepare(`SELECT s.opening_cash + COALESCE((SELECT SUM(amount) FROM cash_movements WHERE shift_id = s.id),0) AS e FROM shifts s WHERE s.user_id = ? AND s.status = 'open'`).get(actor.user!.id) as { e: number }).e;
  closeShift(actor, { countedCash: expected - (rnd() < 0.2 ? egp(Math.round(rnd() * 30)) : 0) });
}
// yogurt batch expires soon with more stock than it can sell
clock.t = end;
createPurchase(ctx, { supplierId: sup.dairy, lines: [{ productId: P('yogurt').id, unitId: carton, qty: 3000, unitCost: egp(7 * 24), expiryDate: inDays(6) }], paid: egp(7 * 72) });
// a big bulk deal on Doritos creates excess stock
createPurchase(ctx, { supplierId: sup.pepsico, lines: [{ productId: P('doritos').id, unitId: carton, qty: 6000, unitCost: egp(12 * 20) }], paid: egp(12 * 20 * 6) });
generateSuggestions(ctx);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log('demo store created at', dir);
