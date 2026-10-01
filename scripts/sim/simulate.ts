/**
 * ONE-YEAR STORE SIMULATION — test tool, never shipped, never run on a customer install.
 *
 * Drives the REAL business engine (the same services the app calls) through a
 * full year of a ~1,500-SKU supermarket: purchases and purchase orders with
 * cost inflation, thousands of invoices (cash / card / wallet / credit, discounts,
 * approvals, weighted items, cartons, promotions), returns, voids, held sales,
 * quotations, damage, expiry disposal, transfers, stocktakes, expenses,
 * customer collections, supplier payments, shifts with deliberate cash
 * variances, daily closing, monthly promotion cycles and daily verified backups.
 *
 * In parallel it keeps an INDEPENDENT shadow model (stock per product/location,
 * drawer cash per shift, customer and supplier balances) computed only from
 * what the simulated people did — `verify.ts` later compares it with the database.
 *
 *   node dist/sim/simulate.js --out sim-output [--days 365] [--products 1500] [--invoices 140] [--seed 7]
 */
import { mkdirSync, writeFileSync, existsSync, copyFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { openDatabase, migrate, type DB } from '../../src/main/db/connection';
import { seedSystemData } from '../../src/main/db/seed';
import { setSettingRaw, defaultLocationId, type Ctx } from '../../src/main/services/context';
import { completeSetup } from '../../src/main/services/settings';
import { login, saveUser } from '../../src/main/services/users';
import { createProduct } from '../../src/main/services/products';
import { saveParty, recordPayment } from '../../src/main/services/parties';
import { createPurchase, createPurchaseReturn, savePurchaseOrder, poReceiveDraft } from '../../src/main/services/purchases';
import { checkout, quoteCart, voidSale, createReturn, holdSale, deleteHeld, createQuotation } from '../../src/main/services/sales';
import { openShift, closeShift, cashInOut } from '../../src/main/services/shifts';
import { createExpense, listExpenseCategories, saveExpenseCategory } from '../../src/main/services/expenses';
import { createAdjustment, createTransfer, saveLocation, startStocktake, getStocktake, setStocktakeCount, completeStocktake } from '../../src/main/services/inventory';
import { closeDay, financialSummary } from '../../src/main/services/reports';
import { generateSuggestions, listSuggestions, approveSuggestion, rejectSuggestion, promotionResults } from '../../src/main/services/recommendations';
import { createBackup } from '../../src/main/backup';
import { makeRng, WeightedPicker } from './rng';
import { buildCatalog, SUPPLIERS, type SimProduct } from './catalog';

/* ------------------------------------------------------------------ args & isolation */
const args = process.argv.slice(2);
const arg = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = resolve(arg('--out', 'sim-output'));
const DAYS = Number(arg('--days', '365'));
const N_PRODUCTS = Number(arg('--products', '1500'));
const BASE_INVOICES = Number(arg('--invoices', '140'));
const SEED = Number(arg('--seed', '7'));
const APP_VERSION = arg('--app-version', '1.0.0');

// Refuse to run anywhere near a real installation's data folder.
const forbidden = [join(homedir(), '.config'), join(homedir(), 'AppData'), join(homedir(), 'Library', 'Application Support')];
if (forbidden.some((f) => OUT.startsWith(f)) || existsSync(join(OUT, 'data', 'store.db'))) {
  console.error(`refusing to run: ${OUT} looks like an application data folder`);
  process.exit(2);
}
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
for (const d of ['backups/daily', 'backups/weekly', 'backups/monthly', 'backups/milestones', 'tmp']) mkdirSync(join(OUT, d), { recursive: true });
writeFileSync(join(OUT, 'SIMULATION-ONLY.txt'), 'بيانات محاكاة اختبارية — ليست بيانات محل حقيقي ولا تُستخدم في أي تثبيت.\n');

const rng = makeRng(SEED);
const db: DB = openDatabase(join(OUT, 'store.db'));
migrate(db);
seedSystemData(db);

/* ------------------------------------------------------------------ clock & people */
const START = new Date(2025, 9, 1); // 1 Oct 2025 .. 30 Sep 2026
const clock = { t: new Date(START.getTime() + 7 * 3600_000) };
const at = (day: number, h: number, m = 0) => { const d = new Date(START); d.setDate(d.getDate() + day); d.setHours(h, m, Math.floor(rng.next() * 60), 0); return d; };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const base: Ctx = { db, user: null, now: () => clock.t };

completeSetup(base, {
  storeName: 'هايبر ماركت المحاكاة', phone: '01000000000', address: 'بيانات اختبار فقط', currencyCode: 'EGP', currencySymbol: 'ج.م',
  adminName: 'المالك', adminUsername: 'owner', adminPassword: 'owner-pass', starterCategories: true, mode: 'advanced', printType: 'thermal80',
});
const owner: Ctx = { ...base, user: login(base, 'owner', 'owner-pass') };
for (const [k, v] of Object.entries({
  'features.expiry': true, 'features.multiLocation': true, 'features.purchaseOrders': true, 'features.promotions': true,
  'features.quotations': true, 'features.creditSales': true, 'sales.allowNegativeStock': false, 'sales.requireShift': true, 'backup.auto': false,
})) setSettingRaw(db, k, v);

const roleId = (code: string) => (db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: number }).id;
const mkUser = (username: string, fullName: string, role: string) => {
  saveUser(owner, null, { username, fullName, password: 'pass1234', roleId: roleId(role) });
  return { ...base, user: login(base, username, 'pass1234') } as Ctx;
};
const manager = mkUser('manager', 'المدير — حسام', 'manager');
const clerk = mkUser('clerk', 'أمين المخزن — سيد', 'inventory');
const cashiers: Ctx[] = [mkUser('c1', 'منى (كاشير)', 'cashier'), mkUser('c2', 'كريم (كاشير)', 'cashier'), mkUser('c3', 'هبة (كاشير)', 'cashier')];
const withApprover = (c: Ctx): Ctx => ({ ...c, approver: manager.user });

const shopId = defaultLocationId(db);
saveLocation(owner, { name: 'المخزن الخلفي', type: 'warehouse' });
const whId = (db.prepare(`SELECT id FROM locations WHERE type = 'warehouse'`).get() as { id: number }).id;
const unitId = (n: string) => (db.prepare('SELECT id FROM units WHERE name = ?').get(n) as { id: number }).id;
const catId = (n: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(n) as { id: number }).id;
const CARTON = unitId('كرتونة');

/* ------------------------------------------------------------------ log / shadow */
const log = {
  config: { out: OUT, days: DAYS, products: N_PRODUCTS, baseInvoices: BASE_INVOICES, seed: SEED, start: iso(START) },
  counts: {} as Record<string, number>,
  errors: [] as { day: string; op: string; code: string; detail?: string }[],
  shifts: [] as { id: number; user: string; expectedShadow: number; plannedVariance: number; expectedDb: number | null; varianceDb: number | null }[],
  months: [] as any[],
  backups: [] as { day: string; type: string; file: string; size: number; ms: number; verified: boolean; schemaVersion: number }[],
  milestones: {} as Record<string, string>,
  promotions: [] as any[],
  users: [] as any[],
  timings: { checkoutMs: [] as number[] },
  shadow: { stock: {} as Record<string, number>, customers: {} as Record<number, number>, suppliers: {} as Record<number, number> },
  plannedShrink: 0,
  questions: {} as Record<string, unknown>,
};
const inc = (k: string, n = 1) => { log.counts[k] = (log.counts[k] ?? 0) + n; };
const fail = (op: string, e: any) => { const code = e?.code ?? e?.name ?? 'ERROR'; inc(`error.${op}.${code}`); if (log.errors.length < 400) log.errors.push({ day: iso(clock.t), op, code, detail: String(e?.message ?? e).slice(0, 200) }); };
const sKey = (pid: number, loc: number) => `${pid}@${loc}`;
const stockOf = (pid: number, loc: number) => log.shadow.stock[sKey(pid, loc)] ?? 0;
const addStock = (pid: number, loc: number, q: number) => { log.shadow.stock[sKey(pid, loc)] = stockOf(pid, loc) + q; };
const addCust = (id: number, v: number) => { log.shadow.customers[id] = (log.shadow.customers[id] ?? 0) + v; };
const addSupp = (id: number, v: number) => { log.shadow.suppliers[id] = (log.shadow.suppliers[id] ?? 0) + v; };

/* ------------------------------------------------------------------ parties */
const suppliers = new Map<string, { id: number; lead: number; visit: readonly number[]; terms: string; costMult: number; raises: number[] }>();
for (const s of SUPPLIERS) {
  const id = saveParty(manager, 'supplier', null, { name: s.name, leadTimeDays: s.lead, phone: `011${rng.int(10000000, 99999999)}` }).id;
  // 2-3 price-list increases a year (inflation), on random days
  const raises = Array.from({ length: rng.int(2, 3) }, () => rng.int(20, DAYS - 20)).sort((a, b) => a - b);
  suppliers.set(s.key, { id, lead: s.lead, visit: s.visit, terms: s.terms, costMult: 1, raises });
}
const customers: { id: number; credit: boolean; weight: number }[] = [];
for (let i = 0; i < 160; i++) {
  const credit = i < 45;
  const id = saveParty(manager, 'customer', null, { name: `عميل ${i + 1}`, phone: `012${rng.int(10000000, 99999999)}`, creditLimit: credit ? rng.int(5, 40) * 10000 : null }).id;
  customers.push({ id, credit, weight: i < 30 ? 6 : 1 });
}
const custPicker = new WeightedPicker(customers.map((_, i) => i), customers.map((c) => c.weight));

/* ------------------------------------------------------------------ catalog */
const catalog = buildCatalog(rng, N_PRODUCTS, DAYS);
interface Live { sp: SimProduct; id: number; unit: number; est: number; costNow: number; priceNow: number; sold: number }
const live = new Map<number, Live>(); // productId -> state
const pending: SimProduct[] = [];
const qtyAvg = (sp: SimProduct) => (sp.weighted ? 800 : 1500); // milli base units per line
const totalPop = catalog.reduce((a, p) => a + p.popularity, 0);
const expectedDaily = (sp: SimProduct) => (BASE_INVOICES * 2.6 * sp.popularity) / totalPop * qtyAvg(sp);
const roundCarton = (sp: SimProduct, q: number) => (sp.cartonFactor ? Math.ceil(q / (sp.cartonFactor * 1000)) * sp.cartonFactor * 1000 : Math.ceil(q / 1000) * 1000);

function createSimProduct(sp: SimProduct, day: number, opening: boolean) {
  const unit = unitId(sp.unit);
  const est = expectedDaily(sp);
  const cover = sp.shelfLife ? Math.min(4, sp.shelfLife[0] / 2) : 14;
  const loc = sp.warehouse ? whId : shopId;
  const qty = opening ? roundCarton(sp, Math.max(est * cover, sp.weighted ? 2000 : 6000)) : 0;
  const expiry = sp.shelfLife ? iso(at(day + rng.int(sp.shelfLife[0], sp.shelfLife[1]), 0)) : null;
  const sup = suppliers.get(sp.supplier)!;
  const r = createProduct(manager, {
    name: sp.name, categoryId: catId(sp.category), baseUnitId: unit, sellPrice: sp.price, cost: sp.cost, isWeighted: sp.weighted,
    trackExpiry: !!sp.shelfLife, defaultSupplierId: sup.id, minStock: Math.round(est * 3 / 1000) * 1000,
    units: sp.cartonFactor ? [{ unitId: CARTON, factor: sp.cartonFactor * 1000, isDefaultPurchase: true }] : [],
    openingStock: qty > 0 ? { qty, unitCost: sp.cost, expiryDate: expiry, locationId: loc } : null,
  });
  if (qty > 0) addStock(r.id, loc, qty);
  live.set(r.id, { sp, id: r.id, unit, est, costNow: sp.cost, priceNow: sp.price, sold: 0 });
  inc('products.created');
}
for (const sp of catalog) { if (sp.launchDay === 0) createSimProduct(sp, 0, true); else pending.push(sp); }

const expCats = new Map<string, number>();
const expCat = (name: string) => {
  if (!expCats.size) for (const c of listExpenseCategories(owner) as any[]) expCats.set(c.name, c.id);
  if (!expCats.has(name)) { saveExpenseCategory(owner, { name }); for (const c of listExpenseCategories(owner) as any[]) expCats.set(c.name, c.id); }
  return expCats.get(name)!;
};

/* ------------------------------------------------------------------ demand model */
const inRange = (d: Date, a: string, b: string) => iso(d) >= a && iso(d) <= b;
function dayFactor(d: Date, day: number): number {
  const dow = d.getDay();
  const w = [0.95, 0.92, 0.93, 1.0, 1.25, 1.15, 1.05][dow];
  const dom = d.getDate();
  const cycle = dom <= 5 ? 1.12 : dom >= 20 && dom <= 27 ? 0.88 : 1;
  let event = 1;
  if (inRange(d, '2026-02-18', '2026-03-19')) event = 1.3; // Ramadan
  if (inRange(d, '2026-03-20', '2026-03-22')) event = 1.45; // Eid al-Fitr
  if (inRange(d, '2026-05-26', '2026-05-29')) event = 1.3; // Eid al-Adha
  if (d.getMonth() === 0) event *= 0.9; // post-holiday January lull
  const growth = 1 + 0.15 * (day / DAYS);
  return w * cycle * event * growth;
}
function seasonFactor(sp: SimProduct, d: Date): number {
  const m = d.getMonth();
  switch (sp.season) {
    case 'summer': return m >= 5 && m <= 7 ? 1.8 : m === 4 || m === 8 ? 1.3 : m === 11 || m <= 1 ? 0.6 : 1;
    case 'winter': return m === 11 || m <= 1 ? 1.5 : m >= 5 && m <= 7 ? 0.7 : 1;
    case 'ramadan': return inRange(d, '2026-02-08', '2026-03-22') ? 2.4 : 1;
    case 'school': return inRange(d, '2025-10-01', '2025-10-15') || inRange(d, '2026-09-10', '2026-09-30') ? 3 : 0.5;
    default: return 1;
  }
}
function trendFactor(sp: SimProduct, day: number): number {
  const x = day / DAYS;
  switch (sp.trend) {
    case 'rising': return 0.5 + 1.2 * x;
    case 'falling': return 1.4 - 1.1 * x;
    case 'dying': return sp.dieDay !== null && day >= sp.dieDay ? 0 : 1;
    case 'new': return day < sp.launchDay ? 0 : Math.min(1, 0.3 + (day - sp.launchDay) / 30);
    default: return 1;
  }
}

/* ------------------------------------------------------------------ promotions in force (reads the store's own promotions table) */
function activePromos(date: string): { product: Set<number>; partner: Map<number, number> } {
  const rows = db.prepare(`SELECT type, product_id, reward_product_id FROM promotions WHERE active = 1 AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)`).all(date, date) as any[];
  const product = new Set<number>(); const partner = new Map<number, number>();
  for (const r of rows) { if (r.product_id) product.add(r.product_id); if (r.reward_product_id && r.product_id) partner.set(r.product_id, r.reward_product_id); }
  return { product, partner };
}

/* ------------------------------------------------------------------ helpers for operations */
const pos = { open: new Map<number, { id: number; expected: number; user: string }>() }; // userId -> shift shadow
function shiftOpen(c: Ctx, opening: number) {
  const s = openShift(c, { openingCash: opening }) as any;
  pos.open.set(c.user!.id, { id: s.id, expected: opening, user: c.user!.fullName });
  inc('shifts.opened');
}
function shiftClose(c: Ctx) {
  const s = pos.open.get(c.user!.id)!;
  const r = rng.next();
  const variance = r < 0.07 ? -rng.int(5, 60) * 100 : r < 0.1 ? rng.int(5, 25) * 100 : 0; // deliberate short / over
  const res = closeShift(c, { countedCash: s.expected + variance, note: variance ? (variance < 0 ? 'عجز في الدرج' : 'زيادة في الدرج') : null }) as any;
  log.shifts.push({ id: s.id, user: s.user, expectedShadow: s.expected, plannedVariance: variance, expectedDb: res.expected_cash ?? null, varianceDb: res.variance ?? null });
  pos.open.delete(c.user!.id);
  inc('shifts.closed');
  if (variance) inc(variance < 0 ? 'shifts.short' : 'shifts.over');
}
const drawer = (c: Ctx, delta: number) => { const s = pos.open.get(c.user!.id); if (s) s.expected += delta; };
const tender = (total: number) => { const steps = [500, 1000, 2000, 5000, 10000, 20000]; const s = rng.pick(steps.filter((x) => x >= Math.min(total, 5000)) as number[]); return rng.chance(0.35) ? total : Math.ceil(total / s) * s; };

interface Recent { id: number; day: number; items: { id: number; pid: number; unit: number; qty: number; base: number; factor: number; left: number }[]; customerId: number | null; method: string; credit: number; cashNet: number; shiftUser: number; voidable: boolean }
let recent: Recent[] = [];
const soldToday = new Map<number, number>();
const quotes: number[] = [];
const pendingPOs: { id: number; day: number; supplierKey: string }[] = [];

function sale(c: Ctx, dayIdx: number, picker: WeightedPicker, promos: ReturnType<typeof activePromos>, opts: { quotationId?: number; heldCart?: any; heldId?: number } = {}) {
  let cart: any = opts.heldCart;
  if (!cart) {
    const n = rng.count(0.38, 10);
    const lines: any[] = [];
    const used = new Set<number>();
    const addLine = (pid: number) => {
      const l = live.get(pid); if (!l || used.has(pid)) return;
      let unit = l.unit; let qty: number; let baseQty: number;
      if (l.sp.weighted) { qty = rng.pick([250, 500, 500, 750, 1000, 1500, 2000]); baseQty = qty; }
      else if (l.sp.cartonFactor && l.sp.cartonFactor >= 6 && rng.chance(0.02)) { unit = CARTON; qty = 1000; baseQty = l.sp.cartonFactor * 1000; }
      else { const k = rng.next() < 0.68 ? 1 : rng.next() < 0.6 ? 2 : rng.int(3, 6); qty = k * 1000; baseQty = qty; }
      if (stockOf(pid, shopId) < baseQty) { inc('sales.lostLine'); return; }
      used.add(pid);
      const line: any = { productId: pid, unitId: unit, qty };
      if (rng.chance(0.01) && !l.sp.weighted) line.discount = { type: 'amount', value: 100 };
      lines.push(line);
    };
    for (let i = 0; i < n; i++) { const pid = picker.pick(rng.next); if (pid !== null) addLine(pid); }
    for (const l of [...lines]) { const partner = promos.partner.get(l.productId); if (partner && rng.chance(0.5)) addLine(partner); }
    if (!lines.length) return null;
    cart = { lines };
    if (rng.chance(0.11)) { const ci = custPicker.pick(rng.next)!; cart.customerId = customers[ci].id; }
    const r = rng.next();
    if (r < 0.025) cart.invoiceDiscount = { type: 'percent', value: 5 };
    else if (r < 0.031) { cart.invoiceDiscount = { type: 'percent', value: 15 }; c = withApprover(c); inc('sales.approvedDiscount'); }
  }
  // hold some carts and resume them (the customer went back for an item)
  if (!opts.heldId && rng.chance(0.006)) {
    const h = holdSale(c, { cart, label: 'معلقة' }) as any;
    inc('held.created');
    if (rng.chance(0.15)) { deleteHeld(c, h.id); inc('held.deleted'); return null; }
    return sale(c, dayIdx, picker, promos, { heldCart: cart, heldId: h.id });
  }
  const q = quoteCart(c, cart) as any;
  if (q.missingApprovals?.length) c = withApprover(c);
  const total: number = q.total;
  const cust = cart.customerId ? customers.find((x) => x.id === cart.customerId)! : null;
  let payments: any[];
  const r = rng.next();
  if (cust?.credit && r < 0.55) { payments = rng.chance(0.3) ? [{ method: 'cash', amount: Math.floor(total * 0.3 / 100) * 100 }] : []; c = withApprover(c); } // credit needs the manager's OK
  else if (r < 0.14) payments = [{ method: 'card', amount: total }];
  else if (r < 0.2) payments = [{ method: 'wallet', amount: total }];
  else payments = [{ method: 'cash', amount: tender(total) }];
  const t0 = performance.now();
  let s: any;
  try {
    s = checkout(c, { cart, payments, heldId: opts.heldId ?? null, quotationId: opts.quotationId ?? null, clientRef: `sim-${dayIdx}-${log.counts['sales.ok'] ?? 0}-${rng.int(0, 1e9)}` });
  } catch (e: any) {
    if (e?.code === 'CREDIT_LIMIT' || e?.code === 'PAYMENT_INSUFFICIENT') {
      inc('sales.creditRefused');
      payments = [{ method: 'cash', amount: tender(total) }];
      try { s = checkout(c, { cart, payments, heldId: opts.heldId ?? null }); } catch (e2) { fail('checkout', e2); return null; }
    } else { fail('checkout', e); return null; }
  }
  log.timings.checkoutMs.push(performance.now() - t0);
  inc('sales.ok'); inc('sales.lines', s.items.length);
  const cashNet = (s.payments as any[]).filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0);
  drawer(c, cashNet);
  if (s.credit_amount > 0) { addCust(s.customer_id, s.credit_amount); inc('sales.credit'); }
  const method = s.credit_amount > 0 ? 'credit' : (s.payments[0]?.method ?? 'cash');
  inc(`sales.method.${method}`);
  if (s.invoice_discount > 0 || s.line_discount > 0) inc('sales.discounted');
  const items = (s.items as any[]).map((it) => {
    addStock(it.product_id, shopId, -it.base_qty);
    soldToday.set(it.product_id, (soldToday.get(it.product_id) ?? 0) + it.base_qty);
    if (it.promotion_id) inc('sales.promoLines');
    if (live.get(it.product_id)?.sp.weighted) inc('sales.weightedLines');
    if (it.unit_id === CARTON) inc('sales.cartonLines');
    return { id: it.id, pid: it.product_id, unit: it.unit_id, qty: it.qty, base: it.base_qty, factor: it.factor, left: it.qty };
  });
  const rec: Recent = { id: s.id, day: dayIdx, items, customerId: s.customer_id, method, credit: s.credit_amount, cashNet, shiftUser: c.user!.id, voidable: true };
  recent.push(rec);
  return rec;
}

function doVoid(c: Ctx, rec: Recent) {
  try {
    voidSale(withApprover(c), { saleId: rec.id, reason: 'خطأ في الإدخال — إلغاء بموافقة المدير' });
  } catch (e) { fail('void', e); return; }
  rec.voidable = false;
  for (const it of rec.items) { addStock(it.pid, shopId, it.base); it.left = 0; }
  // the drawer refund comes from the cashier's open shift (the original one, still open)
  drawer(c, -rec.cashNet);
  if (rec.credit > 0 && rec.customerId) addCust(rec.customerId, -rec.credit);
  inc('sales.voided');
}

function doReturn(c: Ctx, dayIdx: number) {
  const pool = recent.filter((r) => r.voidable !== false && dayIdx - r.day <= 7 && r.items.some((i) => i.left > 0));
  if (!pool.length) return;
  const rec = rng.pick(pool);
  const it = rng.pick(rec.items.filter((i) => i.left > 0));
  const l = live.get(it.pid)!;
  const qty = l.sp.weighted || it.left === 1000 || rng.chance(0.6) ? it.left : 1000;
  const restock = !l.sp.shelfLife || rng.chance(0.4);
  const refundMethod = rec.method === 'credit' && rec.customerId ? 'credit' : rec.method === 'card' ? 'card' : rec.method === 'wallet' ? 'wallet' : 'cash';
  let r: any;
  try {
    r = createReturn(withApprover(c), { saleId: rec.id, items: [{ saleItemId: it.id, qty, restock }], refundMethod, reason: restock ? 'العميل غيّر رأيه' : 'منتج تالف' });
  } catch (e: any) { fail('return', e); return; }
  it.left -= qty;
  rec.voidable = false;
  const base = Math.round((qty * it.factor) / 1000);
  if (restock) addStock(it.pid, shopId, base);
  if (refundMethod === 'cash') drawer(c, -r.total);
  if (refundMethod === 'credit') addCust(rec.customerId!, -r.total);
  inc('returns.ok'); if (!restock) inc('returns.notRestocked');
}

function purchaseFor(supplierKey: string, dayIdx: number, lines: { l: Live; qty: number; unit: number; factor: number }[], poId: number | null, poItems?: Map<number, number>) {
  const sup = suppliers.get(supplierKey)!;
  const invLines = lines.map(({ l, qty, unit, factor }) => {
    const noise = rng.float(0.985, 1.015);
    const costBase = l.sp.cost * sup.costMult * noise;
    const unitCost = Math.round(costBase * factor / 1000);
    const line: any = { productId: l.id, unitId: unit, qty, unitCost };
    if (l.sp.shelfLife) { line.expiryDate = iso(at(dayIdx + rng.int(l.sp.shelfLife[0], l.sp.shelfLife[1]), 0)); line.batchNo = `B${dayIdx}-${l.id}`; }
    // owner policy: follow cost increases on the shelf price most of the time
    if (costBase > l.costNow * 1.04 && rng.chance(0.75)) {
      const ratio = costBase / l.costNow;
      const np = Math.max(25, Math.round((l.priceNow * ratio) / 25) * 25);
      if (np !== l.priceNow) { line.newSellPrice = np; l.priceNow = np; inc('prices.raised'); }
    }
    l.costNow = costBase;
    if (poItems?.has(l.id)) line.poItemId = poItems.get(l.id);
    return line;
  });
  const loc = lines[0].l.sp.warehouse ? whId : shopId;
  const disc = rng.chance(0.05) ? rng.int(1, 3) * 1000 : 0;
  try {
    const p: any = createPurchase(manager, {
      supplierId: sup.id, supplierInvoiceNo: `INV-${dayIdx}-${sup.id}-${rng.int(100, 999)}`, locationId: loc, lines: invLines, discount: disc,
      paid: 0, paymentMethod: 'cash', paidFromDrawer: false, poId,
    });
    const paidNow = sup.terms === 'cash' ? p.total : 0;
    if (paidNow > 0) { recordPayment(owner, 'supplier', { partyId: sup.id, amount: paidNow, method: 'cash', fromDrawer: false, note: 'نقدًا عند الاستلام' }); }
    addSupp(sup.id, p.total - paidNow);
    for (const it of p.items as any[]) addStock(it.product_id, loc, it.base_qty);
    inc('purchases.ok'); inc('purchases.lines', invLines.length); if (poId) inc('purchases.fromPO');
  } catch (e) { fail('purchase', e); }
}

function reorder(supplierKey: string, dayIdx: number) {
  const sup = suppliers.get(supplierKey)!;
  const need: { l: Live; qty: number; unit: number; factor: number }[] = [];
  for (const l of live.values()) {
    if (l.sp.supplier !== supplierKey || (l.sp.trend === 'dying' && l.sp.dieDay !== null && dayIdx >= l.sp.dieDay - 10)) continue;
    const stock = stockOf(l.id, shopId) + stockOf(l.id, whId);
    const cover = l.sp.shelfLife ? Math.min(4, l.sp.shelfLife[0] / 2) : 12;
    if (stock >= l.est * (sup.lead + 3)) continue;
    const want = l.est * (sup.lead + cover) - stock;
    if (want <= 0) continue;
    if (l.sp.cartonFactor) { const cartons = Math.max(1, Math.ceil(want / (l.sp.cartonFactor * 1000))); need.push({ l, qty: cartons * 1000, unit: CARTON, factor: l.sp.cartonFactor * 1000 }); }
    else { const q = l.sp.weighted ? Math.max(1000, Math.ceil(want / 1000) * 1000) : Math.max(1000, Math.ceil(want / 1000) * 1000); need.push({ l, qty: q, unit: l.unit, factor: 1000 }); }
  }
  if (!need.length) return;
  // split by destination (warehouse items vs shop items)
  for (const group of [need.filter((n) => n.l.sp.warehouse), need.filter((n) => !n.l.sp.warehouse)]) {
    if (!group.length) continue;
    if (rng.chance(0.3)) {
      try {
        const po: any = savePurchaseOrder(manager, null, { supplierId: sup.id, locationId: group[0].l.sp.warehouse ? whId : shopId, expectedDate: iso(at(dayIdx + sup.lead, 0)), lines: group.map((n) => ({ productId: n.l.id, unitId: n.unit, qty: n.qty, unitCost: Math.round(n.l.costNow * n.factor / 1000) })) });
        pendingPOs.push({ id: po.id, day: dayIdx + sup.lead, supplierKey });
        inc('po.created');
      } catch (e) { fail('po', e); }
    } else purchaseFor(supplierKey, dayIdx, group, null);
  }
}

function receivePOs(dayIdx: number) {
  for (const po of pendingPOs.filter((p) => p.day <= dayIdx)) {
    try {
      const draft: any = poReceiveDraft(manager, po.id);
      const partial = rng.chance(0.1);
      const lines = (draft.lines as any[]).map((dl) => {
        const l = live.get(dl.productId)!;
        const qty = partial && dl.qty > 1000 ? Math.max(1000, Math.floor(dl.qty * 0.7 / 1000) * 1000) : dl.qty;
        const factor = dl.unitId === CARTON ? l.sp.cartonFactor! * 1000 : 1000;
        return { l, qty, unit: dl.unitId, factor, poItemId: dl.poItemId };
      });
      const poItems = new Map<number, number>(lines.map((x) => [x.l.id, x.poItemId]));
      purchaseFor(po.supplierKey, dayIdx, lines, po.id, poItems);
      inc('po.received'); if (partial) inc('po.partial');
    } catch (e) { fail('poReceive', e); }
  }
  for (let i = pendingPOs.length - 1; i >= 0; i--) if (pendingPOs[i].day <= dayIdx) pendingPOs.splice(i, 1);
}

/* ------------------------------------------------------------------ backups */
const pkgStore = 'هايبر ماركت المحاكاة';
async function backup(dayIdx: number, type: 'daily' | 'weekly' | 'monthly', reason: 'day-close' | 'manual' | 'export') {
  const name = `${type}-${iso(clock.t)}.sbmbak`;
  const file = join(OUT, 'backups', type, name);
  const t0 = performance.now();
  try {
    const info: any = await createBackup(db, file, { appVersion: APP_VERSION, storeName: pkgStore, reason, workDir: join(OUT, 'tmp') });
    const ms = performance.now() - t0;
    log.backups.push({ day: iso(clock.t), type, file, size: statSync(file).size, ms: Math.round(ms), verified: !!info.verified, schemaVersion: info.schemaVersion });
    inc(`backups.${type}`); if (info.verified) inc('backups.verified');
    return file;
  } catch (e) { fail('backup', e); inc('backups.failed'); return null; }
}
function prune(type: string, keep: number) {
  const dir = join(OUT, 'backups', type);
  const files = readdirSync(dir).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) { rmSync(join(dir, f)); inc(`backups.pruned.${type}`); }
}
function milestone(label: string, file: string | null) {
  if (!file) return;
  const dest = join(OUT, 'backups', 'milestones', `${label}.sbmbak`);
  copyFileSync(file, dest);
  log.milestones[label] = dest;
}

/* ------------------------------------------------------------------ month bookkeeping */
function monthSnapshot(label: string, from: string, to: string, wallMs: number) {
  const fin = financialSummary(owner, from, to);
  const stockDb: Record<string, number> = {};
  for (const r of db.prepare('SELECT product_id, location_id, qty FROM product_stock').all() as any[]) stockDb[sKey(r.product_id, r.location_id)] = r.qty;
  let stockDiffs = 0;
  const keys = new Set([...Object.keys(stockDb), ...Object.keys(log.shadow.stock)]);
  for (const k of keys) if ((stockDb[k] ?? 0) !== (log.shadow.stock[k] ?? 0)) stockDiffs++;
  const ms = log.timings.checkoutMs;
  const sorted = [...ms].sort((a, b) => a - b);
  log.months.push({
    label, from, to, wallMs: Math.round(wallMs), invoices: fin.invoices, netSales: fin.netSales, netRevenue: fin.netRevenue, cogs: fin.cogs, grossProfit: fin.grossProfit, expenses: fin.expenses,
    netProfit: fin.netProfit, returns: fin.returns, voids: fin.voids, payments: fin.payments, stockDiffsVsShadow: stockDiffs,
    stockSnapshot: stockDb,
    checkout: { n: ms.length, avg: ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length), p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted[sorted.length - 1] ?? 0 },
    dbBytes: statSync(join(OUT, 'store.db')).size,
  });
  log.timings.checkoutMs = [];
}

function promotionCycle(dayIdx: number) {
  const t0 = performance.now();
  let generated = 0;
  try { generated = (generateSuggestions(owner) as any).generated; } catch (e) { fail('suggest', e); return; }
  const genMs = performance.now() - t0;
  const list = (listSuggestions(owner, { status: 'new' }) as any).items as any[]; // what the owner sees on the screen
  const decisions: any[] = [];
  let approved = 0;
  for (const s of list) {
    const verdict = s.verdict; const kind = s.kind;
    try {
      // owner policy: at most one (multi-day) expiry offer a month, plus the safe pairing / quantity / clearance
      // offers on the screen; offers flagged for review are rejected
      const expiryTaken = decisions.some((d) => d.kind === 'expiry' && d.decision === 'approved');
      const worthIt = kind === 'expiry' ? !expiryTaken && (s.payload?.proposal?.days ?? 1) >= 2 : true;
      if (worthIt && (verdict === 'good' || verdict === 'ok') && approved < 4) {
        approveSuggestion(owner, { id: s.id }); approved++; decisions.push({ id: s.id, kind, verdict, decision: 'approved', title: s.title ?? s.payload?.title });
      } else if (verdict === 'review') {
        rejectSuggestion(owner, { id: s.id, note: 'الهامش غير مناسب حاليًا' }); decisions.push({ id: s.id, kind, verdict, decision: 'rejected' });
      } else decisions.push({ id: s.id, kind, verdict, decision: 'left' });
    } catch (e) { fail('promoDecision', e); }
  }
  log.promotions.push({ day: iso(clock.t), generated, shown: list.length, generateMs: Math.round(genMs), approved, decisions: decisions.slice(0, 30) });
  inc('promos.generated', generated); inc('promos.approved', approved); inc('promos.rejected', decisions.filter((d) => d.decision === 'rejected').length);
}

function userLimitCheck() {
  // try to exceed the default licensed limit (10 active users) and then disable the temporary accounts
  const created: number[] = [];
  let refusedAt: number | null = null;
  for (let i = 0; i < 12; i++) {
    try { created.push(saveUser(owner, null, { username: `temp${i}`, fullName: `موسمي ${i}`, password: 'pass1234', roleId: roleId('cashier') }).id); }
    catch (e: any) { refusedAt = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get() as any).n; if (e?.code !== 'USER_LIMIT') fail('userLimit', e); break; }
  }
  for (const id of created) saveUser(owner, id, { username: (db.prepare('SELECT username FROM users WHERE id = ?').get(id) as any).username, fullName: 'موسمي (موقوف)', roleId: roleId('cashier'), active: false });
  log.users.push({ day: iso(clock.t), event: 'limit-test', createdBeforeLimit: created.length, refusedWhenActive: refusedAt });
}

/* ------------------------------------------------------------------ the year */
(async () => {
  const yearStart = performance.now();
  let monthStart = performance.now();
  let monthFrom = iso(START);
  let morning = 0;
  let evening = 2;
  for (let day = 0; day < DAYS; day++) {
    const date = at(day, 7);
    clock.t = date;
    const dateStr = iso(date);
    const dow = date.getDay();
    if (dow === 6) { morning = (morning + 1) % 2; evening = morning === 0 ? 2 : 1; } // weekly rota: c1/c2 mornings, c3/c2 evenings

    // new products launched today
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].launchDay === day) { createSimProduct(pending[i], day, false); pending.splice(i, 1); inc('products.launchedMidYear'); }
    // supplier price-list increases
    for (const s of suppliers.values()) if (s.raises.includes(day)) { s.costMult *= 1 + rng.float(0.03, 0.09); inc('suppliers.priceRaises'); }

    // 07:00 dispose expired batches
    clock.t = at(day, 7, 10);
    const expired = db.prepare(`SELECT product_id, location_id, SUM(qty) AS q FROM batches WHERE qty > 0 AND expiry_date < ? GROUP BY product_id, location_id`).all(dateStr) as any[];
    for (const b of expired) {
      try { createAdjustment(clerk, { type: 'damage', locationId: b.location_id, reason: 'منتهي الصلاحية — إعدام', lines: [{ productId: b.product_id, qty: b.q }] }); addStock(b.product_id, b.location_id, -b.q); inc('adjust.expiredDisposed'); }
      catch (e) { fail('expiry', e); }
    }
    // 07:30 purchases: receive due POs, then suppliers visiting today
    clock.t = at(day, 7, 30);
    receivePOs(day);
    for (const [key, s] of suppliers) if (s.visit.includes(dow)) reorder(key, day);
    // new products: first delivery
    for (const l of live.values()) if (l.sp.launchDay === day && day > 0) purchaseFor(l.sp.supplier, day, [{ l, qty: l.sp.cartonFactor ? 2000 : 12000, unit: l.sp.cartonFactor ? CARTON : l.unit, factor: l.sp.cartonFactor ? l.sp.cartonFactor * 1000 : 1000 }], null);
    // 07:50 warehouse -> shop transfers
    clock.t = at(day, 7, 50);
    const tLines: { productId: number; qty: number }[] = [];
    for (const l of live.values()) {
      if (!l.sp.warehouse) continue;
      const shop = stockOf(l.id, shopId); const wh = stockOf(l.id, whId);
      if (shop >= l.est * 3 || wh <= 0) continue;
      let q = Math.min(wh, Math.max(l.est * 7, 1000));
      if (!l.sp.weighted && l.sp.cartonFactor) q = Math.min(wh, roundCarton(l.sp, q)); else q = Math.min(wh, Math.ceil(q / 1000) * 1000);
      if (q > 0) tLines.push({ productId: l.id, qty: q });
    }
    if (tLines.length) {
      try { createTransfer(clerk, { fromLocationId: whId, toLocationId: shopId, reason: 'تزويد الرفوف', lines: tLines }); for (const t of tLines) { addStock(t.productId, whId, -t.qty); addStock(t.productId, shopId, t.qty); } inc('transfers.ok'); inc('transfers.lines', tLines.length); }
      catch (e) { fail('transfer', e); }
    }
    // monthly category stocktake (15th) and the year-end full count (last day)
    if (date.getDate() === 15 || day === DAYS - 1) {
      clock.t = at(day, 7, 55);
      const cats = db.prepare('SELECT id FROM categories ORDER BY id').all() as { id: number }[];
      const categoryId = day === DAYS - 1 ? null : cats[date.getMonth() % cats.length].id;
      try {
        const st: any = startStocktake(clerk, { locationId: shopId, categoryId, notes: day === DAYS - 1 ? 'جرد نهاية السنة' : 'جرد شهري' });
        const t0 = performance.now();
        const detail: any = getStocktake(clerk, st.id);
        for (const it of detail.items as any[]) {
          const sys = stockOf(it.product_id, shopId);
          let counted = sys;
          if (sys >= 2000 && rng.chance(0.08)) counted = sys - (live.get(it.product_id)?.sp.weighted ? 250 : 1000);
          else if (rng.chance(0.015)) counted = sys + (live.get(it.product_id)?.sp.weighted ? 250 : 1000);
          setStocktakeCount(clerk, st.id, it.product_id, counted);
          log.plannedShrink += counted - sys;
          addStock(it.product_id, shopId, counted - sys);
        }
        completeStocktake(clerk, st.id);
        inc('stocktakes.ok'); inc('stocktakes.items', detail.items.length);
        if (day === DAYS - 1) log.questions.yearEndStocktake = { items: detail.items.length, ms: Math.round(performance.now() - t0) };
      } catch (e) { fail('stocktake', e); }
    }

    const promos = activePromos(dateStr);
    const weights: number[] = []; const ids: number[] = [];
    for (const l of live.values()) {
      ids.push(l.id);
      weights.push(l.sp.popularity * seasonFactor(l.sp, date) * trendFactor(l.sp, day) * (promos.product.has(l.id) ? 1.6 : 1));
    }
    const picker = new WeightedPicker(ids, weights);
    const nInvoices = Math.max(20, Math.round(BASE_INVOICES * dayFactor(date, day) * rng.float(0.9, 1.1)));

    const mCtx = cashiers[morning]; const eCtx = cashiers[evening];
    const busy = dow === 4 || dow === 5;
    clock.t = at(day, 8, 0); shiftOpen(mCtx, 50000);
    // morning
    const nMorning = Math.round(nInvoices * 0.45);
    for (let i = 0; i < nMorning; i++) {
      clock.t = new Date(at(day, 8, 5).getTime() + (i / nMorning) * 7.7 * 3600_000);
      const rec = sale(mCtx, day, picker, promos);
      if (rec && rng.chance(0.0015)) doVoid(mCtx, rec);
      if (rng.chance(0.008)) doReturn(mCtx, day);
    }
    // midday collections from credit customers
    clock.t = at(day, 13, 0);
    for (const cu of customers.filter((x) => x.credit && (log.shadow.customers[x.id] ?? 0) > 0)) {
      if (!rng.chance(0.08)) continue;
      const bal = log.shadow.customers[cu.id];
      const amount = rng.chance(0.5) ? bal : Math.max(100, Math.floor(bal * rng.float(0.3, 0.8) / 100) * 100);
      try { recordPayment(mCtx, 'customer', { partyId: cu.id, amount, method: 'cash', fromDrawer: true }); addCust(cu.id, -amount); drawer(mCtx, amount); inc('collections.ok'); }
      catch (e) { fail('collect', e); }
    }
    // shift change
    clock.t = at(day, 16, 0); shiftClose(mCtx);
    clock.t = at(day, 16, 2); shiftOpen(eCtx, 50000);
    if (busy) { clock.t = at(day, 17, 0); shiftOpen(manager, 30000); }
    // quotations (Tuesdays) and conversions (Thursdays)
    if (dow === 2) {
      clock.t = at(day, 17, 30);
      const lines = Array.from(live.values()).filter((l) => !l.sp.weighted && stockOf(l.id, shopId) >= 10000).slice(0, 4).map((l) => ({ productId: l.id, unitId: l.unit, qty: 5000 }));
      if (lines.length) { try { const qt: any = createQuotation(manager, { cart: { lines }, customerName: 'طلبية مناسبة', validDays: 7 }); quotes.push(qt.id); inc('quotations.created'); } catch (e) { fail('quotation', e); } }
    }
    const nEvening = nInvoices - nMorning;
    for (let i = 0; i < nEvening; i++) {
      clock.t = new Date(at(day, 16, 5).getTime() + (i / nEvening) * 7.2 * 3600_000);
      const who = busy && rng.chance(0.35) ? manager : eCtx;
      const rec = sale(who, day, picker, promos);
      if (rec && rng.chance(0.0015)) doVoid(who, rec);
      if (rng.chance(0.008)) doReturn(who, day);
      if (busy && i === Math.floor(nEvening / 2)) {
        // the manager pays a small expense from his drawer and moves cash to the safe
        try { const amt = rng.int(2, 15) * 1000; createExpense(manager, { categoryId: expCat('نثريات'), amount: amt, note: 'مستلزمات نظافة', paidFromDrawer: true }); drawer(manager, -amt); inc('expenses.drawer'); } catch (e) { fail('expense', e); }
        const sh = pos.open.get(manager.user!.id)!;
        if (sh.expected > 150000) { try { const amt = 100000; cashInOut(manager, { type: 'withdrawal', amount: amt, note: 'توريد للخزنة' }); drawer(manager, -amt); inc('cash.withdrawals'); } catch (e) { fail('withdraw', e); } }
        if (dow === 4 && quotes.length) {
          const qid = quotes.shift()!;
          if (rng.chance(0.6)) {
            try {
              const qrow: any = db.prepare('SELECT payload FROM quotations WHERE id = ?').get(qid);
              const lines = JSON.parse(qrow.payload).lines;
              if (Array.isArray(lines) && lines.every((ln: any) => stockOf(ln.productId, shopId) >= ln.qty)) { sale(manager, day, picker, promos, { quotationId: qid, heldCart: { lines } }); inc('quotations.converted'); }
            } catch (e) { fail('quoteConvert', e); }
          }
        }
      }
    }
    // shrinkage / damage
    clock.t = at(day, 23, 10);
    if (rng.chance(0.45)) {
      const cands = Array.from(live.values()).filter((l) => stockOf(l.id, shopId) >= 2000);
      if (cands.length) {
        const l = rng.pick(cands);
        const type = rng.chance(0.75) ? 'damage' : 'loss';
        const qty = l.sp.weighted ? 250 : 1000;
        try { createAdjustment(clerk, { type, locationId: shopId, reason: type === 'damage' ? 'كسر / تلف على الرف' : 'عجز غير مبرر', lines: [{ productId: l.id, qty }] }); addStock(l.id, shopId, -qty); inc(`adjust.${type}`); }
        catch (e) { fail('adjust', e); }
      }
    }
    if (date.getDate() === 20) {
      // monthly return of damaged goods to a supplier (credited to our balance)
      const cands = Array.from(live.values()).filter((l) => !l.sp.weighted && stockOf(l.id, shopId) >= 3000 && (log.shadow.suppliers[suppliers.get(l.sp.supplier)!.id] ?? 0) > 100000);
      if (cands.length) {
        const l = rng.pick(cands); const sup = suppliers.get(l.sp.supplier)!;
        try {
          const pr: any = createPurchaseReturn(manager, { supplierId: sup.id, locationId: shopId, lines: [{ productId: l.id, unitId: l.unit, qty: 2000, unitCost: Math.round(l.costNow) }], refundMethod: 'balance', reason: 'تالف من المصدر' });
          addStock(l.id, shopId, -2000); addSupp(sup.id, -pr.total); inc('purchaseReturns.ok');
        } catch (e) { fail('purchaseReturn', e); }
      }
    }
    // weekly expiry review (Mondays): the owner sends near-expiry batches back to their supplier (batch-aware return)
    if (dow === 1) {
      const near = db.prepare(
        `SELECT b.id, b.product_id, b.location_id, b.qty, b.supplier_id FROM batches b
         WHERE b.qty >= 2000 AND b.supplier_id IS NOT NULL AND b.expiry_date >= ? AND b.expiry_date <= ? ORDER BY b.expiry_date LIMIT 4`,
      ).all(dateStr, iso(at(day + 5, 0))) as { id: number; product_id: number; location_id: number; qty: number; supplier_id: number }[];
      for (const b of near) {
        const l = live.get(b.product_id); if (!l || l.sp.weighted) continue;
        const q = Math.floor(b.qty / 2000) * 1000; // half the batch, whole pieces
        if (q <= 0 || stockOf(b.product_id, b.location_id) < q) continue;
        try {
          const pr: any = createPurchaseReturn(manager, { supplierId: b.supplier_id, refundMethod: 'balance', reason: 'قرب انتهاء الصلاحية', lines: [{ batchId: b.id, productId: b.product_id, unitId: l.unit, qty: q }] });
          addStock(b.product_id, b.location_id, -q); addSupp(b.supplier_id, -pr.total); inc('purchaseReturns.expiryBatch');
        } catch (e) { fail('expiryReturn', e); }
      }
    }
    // close registers
    clock.t = at(day, 23, 30); shiftClose(eCtx);
    if (busy) { clock.t = at(day, 23, 31); shiftClose(manager); }

    // back office: expenses and supplier payments
    clock.t = at(day, 23, 35);
    const dom = date.getDate();
    const exp = (name: string, amount: number, note: string) => { try { createExpense(owner, { categoryId: expCat(name), amount, note, paidFromDrawer: false, businessDate: dateStr }); inc('expenses.ok'); } catch (e) { fail('expense', e); } };
    if (dom === 1) exp('إيجار', 1_200_000, 'إيجار المحل');
    if (dom === 10) exp('كهرباء ومياه', rng.int(150, date.getMonth() >= 5 && date.getMonth() <= 8 ? 520 : 300) * 1000, 'فاتورة الكهرباء');
    if (dom === 28) exp('رواتب', 2_600_000, 'رواتب العاملين');
    if (rng.chance(0.3)) exp('نقل ومواصلات', rng.int(5, 30) * 1000, 'نقل بضاعة');
    if (dow === 0) {
      for (const s of suppliers.values()) {
        const bal = log.shadow.suppliers[s.id] ?? 0;
        if (s.terms !== 'credit' || bal <= 50000) continue;
        const amount = Math.floor(bal * rng.float(0.7, 1) / 100) * 100;
        try { recordPayment(owner, 'supplier', { partyId: s.id, amount, method: 'bank', fromDrawer: false, note: 'تحويل بنكي' }); addSupp(s.id, -amount); inc('supplierPayments.ok'); }
        catch (e) { fail('supplierPay', e); }
      }
    }
    // staff change mid-year: a cashier leaves (disabled, never deleted) and a new one joins
    if (day === 182) {
      const leaving = cashiers[1];
      saveUser(owner, leaving.user!.id, { username: 'c2', fullName: 'كريم (ترك العمل)', roleId: roleId('cashier'), active: false });
      cashiers[1] = mkUser('c4', 'ياسمين (كاشير جديدة)', 'cashier');
      log.users.push({ day: dateStr, event: 'cashier replaced', disabled: 'c2', added: 'c4' });
      userLimitCheck();
    }

    // day close + verified backup
    clock.t = at(day, 23, 45);
    try { closeDay(owner, dateStr); inc('days.closed'); } catch (e) { fail('closeDay', e); }
    clock.t = at(day, 23, 50);
    const file = await backup(day, 'daily', 'day-close');
    prune('daily', 7);
    if (dow === 5 && file) { copyFileSync(file, join(OUT, 'backups', 'weekly', `weekly-${dateStr}.sbmbak`)); inc('backups.weekly'); prune('weekly', 8); }
    const tomorrow = at(day + 1, 7);
    const monthEnd = tomorrow.getMonth() !== date.getMonth() || day === DAYS - 1;
    if (day === 0) milestone('day-001', file);
    if (monthEnd && file) {
      copyFileSync(file, join(OUT, 'backups', 'monthly', `monthly-${dateStr}.sbmbak`)); inc('backups.monthly');
      const mIdx = log.months.length + 1;
      if (mIdx === 1) milestone('month-01', file);
      if (mIdx === 6) milestone('month-06', file);
      if (mIdx === 12 || day === DAYS - 1) milestone('month-12', file);
    }

    // EWMA demand estimate the store "learns" from its own sales
    for (const l of live.values()) { const s = soldToday.get(l.id) ?? 0; l.est = 0.85 * l.est + 0.15 * s; l.sold += s; }
    soldToday.clear();
    recent = recent.filter((r) => day - r.day <= 7);

    if (monthEnd) {
      monthSnapshot(dateStr.slice(0, 7), monthFrom, dateStr, performance.now() - monthStart);
      process.stdout.write(`month ${dateStr.slice(0, 7)}: invoices=${log.months.at(-1).invoices} netSales=${(log.months.at(-1).netSales / 100).toFixed(0)} EGP wall=${(log.months.at(-1).wallMs / 1000).toFixed(1)}s diffs=${log.months.at(-1).stockDiffsVsShadow}\n`);
      monthStart = performance.now(); monthFrom = iso(tomorrow);
      // monthly promotion cycle for the coming month (needs a month of history first)
      if (day < DAYS - 1) { clock.t = at(day + 1, 6, 30); promotionCycle(day + 1); }
    }
  }
  // final promotion results and the owner's end-of-year questions
  clock.t = at(DAYS - 1, 23, 58);
  try { log.questions.promotionResults = promotionResults(owner); } catch (e) { fail('promoResults', e); }
  log.counts.wallSeconds = Math.round((performance.now() - yearStart) / 1000);
  for (const [k, v] of Object.entries(log.shadow.customers)) if (!v) delete log.shadow.customers[k as any];
  writeFileSync(join(OUT, 'sim-log.json'), JSON.stringify(log));
  db.close();
  console.log(`done in ${log.counts.wallSeconds}s — invoices ${log.counts['sales.ok']}, errors ${log.errors.length}`);
})().catch((e) => { console.error(e); process.exit(1); });
