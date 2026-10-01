import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupStore, addProduct, asRole, egp } from './helpers';
import { routes } from '../../src/main/api';
import { checkout } from '../../src/main/services/sales';
import { saveUser, userQuota, login } from '../../src/main/services/users';
import { LicenseManager, formatMachineCode, type LicensePayload, type LicenseStorage, type SealedRecord } from '../../src/main/license/core';
import { limitsFrom, DEFAULT_MAX_USERS, HARD_MAX_USERS } from '../../src/shared/license-policy';
import { createBackup, restoreBackup, validateBackup } from '../../src/main/backup';
import { openDatabase, migrate, SCHEMA_VERSION } from '../../src/main/db/connection';
import { MIGRATIONS } from '../../src/main/db/schema';
import { seedSystemData } from '../../src/main/db/seed';
import { APP_ID } from '../../src/shared/brand';

/* ------------------------------------------------------------------ permissions sweep */

/** Routes a cashier is expected to reach (selling, own shift, lookups). Everything else must be FORBIDDEN. */
const CASHIER_ALLOWED = new Set([
  'auth.changePassword', 'settings.get', 'users.names', 'users.quota', 'roles.list',
  'products.list', 'products.get', 'products.priceHistory', 'pos.search', 'pos.product',
  'categories.list', 'brands.list', 'units.list', 'groups.list', 'priceLists.list', 'locations.list', 'promotions.list',
  'inventory.ledger', 'inventory.movements', 'inventory.batches', 'inventory.docs', 'inventory.expiry',
  'sales.quote', 'sales.checkout', 'sales.get', 'sales.find', 'sales.list', 'sales.void',
  'returns.create', 'returns.get', 'returns.list',
  'held.create', 'held.list', 'held.get', 'held.delete',
  'shifts.current', 'shifts.open', 'shifts.close', 'shifts.summary', 'shifts.list', 'shifts.movements',
  'customers.list', 'customers.get', 'customers.save', 'customers.delete', 'customers.pay', 'customers.adjust', 'suppliers.adjust',
  'expenses.categories',
  'reports.dashboard', 'reports.alerts', 'reports.lowStock', 'reports.reorder', 'reports.deadStock', 'reports.expiring', 'reports.valuation',
]);
const SENSITIVE_KEY = /(cost|cogs|profit|margin)/i; // revenue (gross sales) is fine for a cashier; cost-derived numbers are not

function findSensitive(v: unknown, path: string, out: string[]) {
  if (Array.isArray(v)) { v.slice(0, 50).forEach((x, i) => findSensitive(x, `${path}[${i}]`, out)); return; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (SENSITIVE_KEY.test(k) && !path.startsWith('settings.get') && typeof x === 'number' && x !== 0) out.push(`${path}.${k}=${x}`);
      else findSensitive(x, `${path}.${k}`, out);
    }
  }
}

describe('cashier permission sweep over every API route (spec §29/§71)', () => {
  it('every route outside the cashier set is FORBIDDEN, and the allowed ones never reveal cost or profit', async () => {
    const env = setupStore({ settings: { 'features.expiry': true } });
    const pid = addProduct(env, { name: 'زبادي', price: 10, cost: 6, qty: 50, trackExpiry: true, expiry: '2026-10-05' });
    addProduct(env, { name: 'أرز', price: 30, cost: 22, qty: 5, minStock: 10 });
    const cashier = asRole(env, 'cashier', { shift: true });
    const sale = checkout(cashier, { cart: { lines: [{ productId: pid, unitId: env.unit('قطعة'), qty: 2000 }] }, payments: [{ method: 'cash', amount: egp(20) }] });
    const payload: Record<string, unknown> = {
      'products.get': { id: pid }, 'products.priceHistory': { id: pid }, 'pos.product': { id: pid },
      'inventory.ledger': { productId: pid }, 'inventory.batches': { productId: pid }, 'inventory.movements': { from: '2026-01-01', to: '2026-12-31' },
      'sales.get': { id: sale.id }, 'sales.find': { invoiceNo: sale.invoiceNo }, 'sales.list': {},
    };
    const unexpected: string[] = [];
    const leaks: string[] = [];
    for (const [name, r] of Object.entries(routes)) {
      if (r.public) continue;
      let result: unknown; let code = 'OK';
      try { result = await r.fn(cashier, payload[name] ?? {}); } catch (e: any) { code = e?.code ?? e?.name ?? 'ERR'; }
      if (code === 'FORBIDDEN') continue;
      if (!CASHIER_ALLOWED.has(name)) unexpected.push(`${name}:${code}`);
      if (code === 'OK') findSensitive(result, name, leaks);
    }
    expect(unexpected).toEqual([]);
    expect(leaks).toEqual([]);
  });

  it('the same routes do return cost to the owner (masking is per-permission, not a removal)', async () => {
    const env = setupStore({ settings: { 'features.expiry': true } });
    const pid = addProduct(env, { name: 'زبادي', price: 10, cost: 6, qty: 50, trackExpiry: true, expiry: '2026-10-05' });
    const ledger = await routes['inventory.ledger'].fn(env.ctx, { productId: pid }) as any[];
    expect(ledger[0].unit_cost).toBe(600);
    const batches = await routes['inventory.batches'].fn(env.ctx, { productId: pid }) as any[];
    expect(batches[0].unit_cost).toBe(600);
  });
});

/* ------------------------------------------------------------------ user limit */

describe('licensed user limit (spec §24/§27)', () => {
  const role = (env: ReturnType<typeof setupStore>, code: string) => (env.ctx.db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: number }).id;
  const add = (env: ReturnType<typeof setupStore>, username: string, active = true) =>
    saveUser(env.ctx, null, { username, fullName: username, password: '1234', roleId: role(env, 'cashier'), active });

  it('adds users up to the limit, refuses the next one with a clear message, and frees a slot when a user is disabled', () => {
    const env = setupStore();
    env.ctx.limits = { maxUsers: 3 };
    expect(userQuota(env.ctx)).toEqual({ active: 1, max: 3, canAdd: true });
    add(env, 'c1');
    const c2 = add(env, 'c2');
    expect(userQuota(env.ctx)).toEqual({ active: 3, max: 3, canAdd: false });
    expect(() => add(env, 'c3')).toThrow('USER_LIMIT');
    // an inactive account does not take a seat
    const spare = add(env, 'spare', false);
    // disabling (never deleting) frees the seat; history stays linked to the old user
    saveUser(env.ctx, c2.id, { username: 'c2', fullName: 'c2', roleId: role(env, 'cashier'), active: false });
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get('c2')).toEqual({ n: 1 });
    expect(() => login(env.ctx, 'c2', '1234')).toThrow();
    add(env, 'c3');
    // re-activating someone when the store is full is also refused
    expect(() => saveUser(env.ctx, spare.id, { username: 'spare', fullName: 'spare', roleId: role(env, 'cashier'), active: true })).toThrow('USER_LIMIT');
    // editing an already-active user at the limit is fine
    saveUser(env.ctx, c2.id - 1, { username: 'c1', fullName: 'كاشير 1', roleId: role(env, 'cashier'), active: true });
  });

  it('without license limits (trial / legacy) the default applies', () => {
    const env = setupStore();
    expect(userQuota(env.ctx).max).toBe(DEFAULT_MAX_USERS);
    for (let i = 1; i < DEFAULT_MAX_USERS; i++) add(env, `u${i}`);
    expect(() => add(env, 'one-too-many')).toThrow('USER_LIMIT');
  });
});

/* ------------------------------------------------------------------ license backward compatibility */

describe('license editions and backward compatibility (spec §30)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const MACHINE = formatMachineCode('m-guid', 'com.sabermarko.pos');
  const b64 = (x: Buffer) => x.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const issue = (p: Record<string, unknown>) => {
    const data = Buffer.from(JSON.stringify({ v: 1, id: 'L', type: 'permanent', customer: 'محل', machine: MACHINE, issued: '2026-10-01', expires: null, ...p } as LicensePayload));
    return `SBM1.${b64(data)}.${b64(sign(null, Buffer.concat([Buffer.from('SBM1.'), data]), privateKey))}`;
  };
  const mgr = () => {
    const store: (SealedRecord | null)[] = [null, null, null];
    const storage: LicenseStorage = { readAll: () => store.map((s) => (s ? JSON.parse(JSON.stringify(s)) : s)), writeAll: (r) => { for (let i = 0; i < 3; i++) store[i] = JSON.parse(JSON.stringify(r)); } };
    const m = new LicenseManager(storage, MACHINE, PUB, () => new Date(2026, 9, 1).getTime(), () => 'i', () => 0);
    m.load();
    return m;
  };

  it('policy: legacy keys get the default, editions map to limits, explicit maxUsers wins, absurd values are capped', () => {
    expect(limitsFrom(null).maxUsers).toBe(DEFAULT_MAX_USERS);
    expect(limitsFrom({}).maxUsers).toBe(DEFAULT_MAX_USERS);
    expect(limitsFrom({ edition: 'basic' }).maxUsers).toBe(2);
    expect(limitsFrom({ edition: 'professional' })).toMatchObject({ maxUsers: 15, editionLabel: 'الباقة الاحترافية' });
    expect(limitsFrom({ edition: 'basic', maxUsers: 7 }).maxUsers).toBe(7);
    expect(limitsFrom({ edition: 'unknown-edition' }).maxUsers).toBe(DEFAULT_MAX_USERS);
    expect(limitsFrom({ maxUsers: -3 }).maxUsers).toBe(DEFAULT_MAX_USERS);
    expect(limitsFrom({ maxUsers: 100000 }).maxUsers).toBe(HARD_MAX_USERS);
  });

  it('a key issued before editions existed still activates and gets the default limit', () => {
    const m = mgr();
    expect(m.status().limits.maxUsers).toBe(DEFAULT_MAX_USERS); // trial
    expect(m.activate(issue({})).ok).toBe(true);
    expect(m.status()).toMatchObject({ state: 'licensed', limits: { maxUsers: DEFAULT_MAX_USERS, edition: null }, features: [] });
  });

  it('a new key carries edition, maxUsers, features and store identity', () => {
    const m = mgr();
    expect(m.activate(issue({ edition: 'standard', maxUsers: 6, features: ['multi-location'], store: 'محل البركة' })).ok).toBe(true);
    expect(m.status()).toMatchObject({ state: 'licensed', limits: { maxUsers: 6, edition: 'standard' }, features: ['multi-location'] });
  });

  it('a stored key signed by a rotated vendor key is not reported as tampering — it simply needs re-activation', () => {
    const store: (SealedRecord | null)[] = [null, null, null];
    const storage: LicenseStorage = { readAll: () => store.map((s) => (s ? JSON.parse(JSON.stringify(s)) : s)), writeAll: (r) => { for (let i = 0; i < 3; i++) store[i] = JSON.parse(JSON.stringify(r)); } };
    const t0 = new Date(2026, 9, 1).getTime();
    const clock = { t: t0 };
    const a = new LicenseManager(storage, MACHINE, PUB, () => clock.t, () => 'i', () => 0); a.load();
    expect(a.activate(issue({})).ok).toBe(true);
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const b = new LicenseManager(storage, MACHINE, other, () => clock.t, () => 'i', () => 0); b.load();
    expect(b.status().state).toBe('trial');
    clock.t = t0 + 30 * 86_400_000;
    const c = new LicenseManager(storage, MACHINE, other, () => clock.t, () => 'i', () => 0); c.load();
    expect(c.status()).toMatchObject({ state: 'expired', canOperate: false });
  });

  it('the limit fields are covered by the signature (cannot be raised by editing the key)', () => {
    const m = mgr();
    const key = issue({ edition: 'basic' });
    const [h, , s] = key.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, id: 'L', type: 'permanent', customer: 'محل', machine: MACHINE, issued: '2026-10-01', expires: null, edition: 'basic', maxUsers: 99 }));
    expect(m.activate(`${h}.${b64(forged)}.${s}`).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ backup version policy */

describe('backup version policy (spec §18)', () => {
  it('a backup made by an older schema (v1) restores into the current version and is migrated without data loss', async () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(1);
    const dir = mkdtempSync(join(tmpdir(), 'sbm-old-'));
    // build a genuine v1 database (as shipped by 1.0.0 before the intelligence update)
    const oldPath = join(dir, 'old.db');
    const old = openDatabase(oldPath);
    old.exec(MIGRATIONS[0]); old.pragma('user_version = 1');
    old.prepare("INSERT INTO app_meta(key, value) VALUES ('app_id', ?)").run(APP_ID);
    seedSystemData(old);
    old.prepare(`INSERT INTO promotions(name, type, min_qty, value, active, created_at) VALUES ('عرض قديم', 'percent', 1000, 10, 1, '2026-01-01 10:00:00')`).run();
    const file = join(dir, 'old.sbmbak');
    const made = await createBackup(old, file, { appVersion: '1.0.0', storeName: 'محل قديم' });
    old.close();
    expect(made.schemaVersion).toBe(1);
    const { info } = await validateBackup(file, dir);
    expect(info.migrationNeeded).toBe(true);
    // current install
    const livePath = join(dir, 'live.db');
    let live = openDatabase(livePath); migrate(live); seedSystemData(live);
    const res = await restoreBackup({ file, dbPath: livePath, workDir: dir, db: live, appVersion: '1.1.0', storeName: 'x', close: () => live.close(), reopen: () => { live = openDatabase(livePath); migrate(live); return live; } });
    expect(res.after?.products).toBe(0);
    expect(live.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(live.prepare('SELECT name, type, value FROM promotions').get()).toEqual({ name: 'عرض قديم', type: 'percent', value: 10 });
    expect(live.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'promotion_suggestions'").get()).toEqual({ n: 1 });
    expect(live.pragma('foreign_key_check')).toEqual([]);
    live.close();
  });
});
