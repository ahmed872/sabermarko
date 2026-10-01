import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LicenseManager, TRIAL_DAYS, formatMachineCode, seal, type LicenseStorage, type SealedRecord, type LicensePayload } from '../../src/main/license/core';
import { createBackup, readHeader, restoreBackup, validateBackup, listBackups, pruneBackups } from '../../src/main/backup';
import { openDatabase, migrate } from '../../src/main/db/connection';
import { seedSystemData } from '../../src/main/db/seed';
import { setupStore, addProduct, egp } from './helpers';
import { checkout } from '../../src/main/services/sales';

const DAY = 86_400_000;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const MACHINE = formatMachineCode('test-machine-guid', 'com.sabermarko.pos');

function issue(p: Partial<LicensePayload>): string {
  const payload: LicensePayload = { v: 1, id: 'L1', type: 'permanent', customer: 'سوبر ماركت البركة', machine: MACHINE, issued: '2026-10-01', expires: null, ...p };
  const data = Buffer.from(JSON.stringify(payload));
  const sig = sign(null, Buffer.concat([Buffer.from('SBM1.'), data]), privateKey);
  const b = (x: Buffer) => x.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `SBM1.${b(data)}.${b(sig)}`;
}

function memStorage(slots = 3) {
  const store: (SealedRecord | null | 'corrupt')[] = Array(slots).fill(null);
  const storage: LicenseStorage = { readAll: () => store.map((s) => (s && s !== 'corrupt' ? JSON.parse(JSON.stringify(s)) : s)), writeAll: (r) => { for (let i = 0; i < store.length; i++) store[i] = JSON.parse(JSON.stringify(r)); } };
  return { store, storage };
}

function manager(storage: LicenseStorage, clock: { t: number }, latestData = () => 0) {
  const m = new LicenseManager(storage, MACHINE, PUB, () => clock.t, () => 'install-1', latestData);
  m.load();
  return m;
}

describe('licensing (spec §58-60)', () => {
  const start = new Date(2026, 9, 1, 9, 0).getTime();

  it('starts a 20-day trial and expires after it', () => {
    const clock = { t: start };
    const { storage } = memStorage();
    const m = manager(storage, clock);
    expect(m.status()).toMatchObject({ state: 'trial', canOperate: true, daysLeft: TRIAL_DAYS });
    clock.t = start + 19 * DAY;
    expect(m.status()).toMatchObject({ state: 'trial', daysLeft: 1 });
    clock.t = start + 20 * DAY + 1;
    expect(m.status()).toMatchObject({ state: 'expired', canOperate: false });
  });

  it('reinstalling (deleting one store) does not reset the trial', () => {
    const clock = { t: start };
    const { store, storage } = memStorage();
    manager(storage, clock);
    clock.t = start + 25 * DAY;
    store[0] = null; // user deleted the app data folder
    store[2] = null; // and the database
    const m2 = manager(storage, clock);
    expect(m2.status().state).toBe('expired');
  });

  it('detects tampering with the stored trial date', () => {
    const clock = { t: start };
    const { store, storage } = memStorage();
    manager(storage, clock);
    const rec = store[0] as SealedRecord;
    store[0] = { data: { ...rec.data, trialStart: start + 100 * DAY }, seal: rec.seal }; // edited without a valid seal
    store[1] = 'corrupt';
    store[2] = { data: { ...rec.data, trialStart: start + 100 * DAY }, seal: rec.seal };
    const m = manager(storage, clock);
    expect(m.status()).toMatchObject({ state: 'tampered', canOperate: false });
  });

  it('a record sealed for another machine is rejected', () => {
    const clock = { t: start };
    const { store, storage } = memStorage();
    const other = seal({ installId: 'x', trialStart: start, lastSeen: start, licenseKey: null }, 'OTHER-MACHINE');
    store[0] = other; store[1] = other; store[2] = other;
    expect(manager(storage, clock).status().state).toBe('tampered');
  });

  it('detects the clock being turned back (beyond tolerance) and blocks until fixed', () => {
    const clock = { t: start + 10 * DAY };
    const { storage } = memStorage();
    const m = manager(storage, clock);
    m.touch();
    clock.t = start + 2 * DAY; // user rolled the clock back 8 days to extend the trial
    expect(m.status()).toMatchObject({ state: 'clock', canOperate: false });
    clock.t = start + 10 * DAY + 3600_000;
    expect(m.status().state).toBe('trial');
  });

  it('also detects rollback against the latest transaction time in the database', () => {
    const clock = { t: start };
    const { storage } = memStorage();
    const m = manager(storage, clock, () => start + 5 * DAY);
    expect(m.status().state).toBe('clock');
  });

  it('small clock corrections (timezone/DST) are tolerated', () => {
    const clock = { t: start + DAY };
    const { storage } = memStorage();
    const m = manager(storage, clock);
    m.touch();
    clock.t = start + DAY - 2 * 3600_000;
    expect(m.status().state).toBe('trial');
  });

  it('activates permanent and temporary licenses; rejects invalid, foreign and expired keys', () => {
    const clock = { t: start };
    const { storage } = memStorage();
    const m = manager(storage, clock);
    clock.t = start + 30 * DAY;
    expect(m.status().state).toBe('expired');
    expect(m.activate('garbage')).toMatchObject({ ok: false, error: 'LICENSE_INVALID' });
    const forged = issue({}).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(m.activate(forged)).toMatchObject({ ok: false, error: 'LICENSE_INVALID' });
    expect(m.activate(issue({ machine: 'AAAAA-BBBBB-CCCCC-DDDDD' }))).toMatchObject({ ok: false, error: 'LICENSE_WRONG_MACHINE' });
    expect(m.activate(issue({ type: 'temporary', expires: '2026-10-05' }))).toMatchObject({ ok: false, error: 'LICENSE_EXPIRED' });
    // payload edited to permanent but signature from a temporary key -> invalid
    const temp = issue({ type: 'temporary', expires: '2027-01-30' });
    const [, data, sig] = temp.split('.');
    const edited = JSON.parse(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    edited.type = 'permanent';
    const tamperedKey = `SBM1.${Buffer.from(JSON.stringify(edited)).toString('base64').replace(/=+$/, '')}.${sig}`;
    expect(m.activate(tamperedKey)).toMatchObject({ ok: false, error: 'LICENSE_INVALID' });
    expect(m.activate(temp).ok).toBe(true);
    expect(m.status()).toMatchObject({ state: 'licensed', type: 'temporary', canOperate: true });
    clock.t = new Date(2027, 0, 31, 9).getTime();
    expect(m.status()).toMatchObject({ state: 'expired', type: 'temporary', canOperate: false });
    expect(m.activate(issue({ type: 'permanent' })).ok).toBe(true);
    clock.t = new Date(2035, 0, 1).getTime();
    expect(m.status()).toMatchObject({ state: 'licensed', type: 'permanent', daysLeft: null });
  });

  it('license survives restarts (stored and re-read)', () => {
    const clock = { t: start };
    const { storage } = memStorage();
    manager(storage, clock).activate(issue({}));
    expect(manager(storage, clock).status().state).toBe('licensed');
  });
});

describe('backup & restore (spec §62)', () => {
  function tmp() { return mkdtempSync(join(tmpdir(), 'sbm-bk-')); }

  it('creates a validated, versioned backup and restores it', async () => {
    const dir = tmp();
    const dbPath = join(dir, 'store.db');
    let db = openDatabase(dbPath); migrate(db); seedSystemData(db);
    db.prepare(`INSERT INTO settings(key, value) VALUES ('store.name', '"البركة"')`).run();
    const file = join(dir, 'b1.sbmbak');
    const info = await createBackup(db, file, { appVersion: '1.0.0', storeName: 'البركة', reason: 'manual' });
    expect(info.schemaVersion).toBeGreaterThan(0);
    expect(readHeader(file).storeName).toBe('البركة');
    // change data after backup
    db.prepare(`UPDATE settings SET value = '"تغيير"' WHERE key = 'store.name'`).run();
    const res = await restoreBackup({ file, dbPath, workDir: dir, db, appVersion: '1.0.0', storeName: 'x', close: () => db.close(), reopen: () => { db = openDatabase(dbPath); migrate(db); return db; } });
    expect(res.info.counts?.users).toBe(0);
    expect((db.prepare(`SELECT value FROM settings WHERE key = 'store.name'`).get() as any).value).toBe('"البركة"');
    expect(existsSync(res.safetyFile)).toBe(true); // a safety copy of the replaced data exists
    db.close();
  });

  it('rejects corrupted, foreign and newer-version backups without touching current data', async () => {
    const dir = tmp();
    const dbPath = join(dir, 'store.db');
    const db = openDatabase(dbPath); migrate(db); seedSystemData(db);
    const file = join(dir, 'b.sbmbak');
    await createBackup(db, file, { appVersion: '1.0.0', storeName: 's' });
    const buf = readFileSync(file);
    const corrupt = Buffer.from(buf); corrupt[corrupt.length - 20] ^= 0xff;
    writeFileSync(join(dir, 'corrupt.sbmbak'), corrupt);
    expect(() => validateBackup(join(dir, 'corrupt.sbmbak'), dir)).toThrow('BACKUP_INVALID');
    writeFileSync(join(dir, 'random.sbmbak'), 'not a backup at all');
    expect(() => validateBackup(join(dir, 'random.sbmbak'), dir)).toThrow('BACKUP_INVALID');
    // newer schema version
    const text = buf.toString('latin1');
    const nl1 = text.indexOf('\n'); const nl2 = text.indexOf('\n', nl1 + 1);
    const header = JSON.parse(buf.subarray(nl1 + 1, nl2).toString('utf8'));
    header.schemaVersion = 999;
    writeFileSync(join(dir, 'newer.sbmbak'), Buffer.concat([buf.subarray(0, nl1 + 1), Buffer.from(JSON.stringify(header)), buf.subarray(nl2)]));
    expect(() => validateBackup(join(dir, 'newer.sbmbak'), dir)).toThrow('BACKUP_NEWER');
    await expect(restoreBackup({ file: join(dir, 'corrupt.sbmbak'), dbPath, workDir: dir, db, appVersion: '1', storeName: 's', close: () => db.close(), reopen: () => db })).rejects.toThrow('BACKUP_INVALID');
    expect(db.open).toBe(true); // live db never closed for an invalid file
    const list = listBackups(dir);
    expect(list.filter((b) => b.reason === 'invalid').length).toBe(2); // newer one is readable but refused on restore
    db.close();
  });

  it('backs up while the store is in use (consistent snapshot) and prunes old automatic backups', async () => {
    const env = setupStore();
    const id = addProduct(env, { name: 'A', price: 10, qty: 100 });
    for (let i = 0; i < 5; i++) checkout(env.ctx, { cart: { lines: [{ productId: id, unitId: env.unit('قطعة'), qty: 1000 }] }, payments: [{ method: 'cash', amount: egp(10) }] });
    const dir = tmp();
    // :memory: databases cannot be backed up by path; copy into a file db first
    const fileDb = join(dir, 'live.db');
    env.ctx.db.exec(`VACUUM INTO '${fileDb.replace(/'/g, "''")}'`);
    const live = openDatabase(fileDb);
    for (let i = 0; i < 4; i++) await createBackup(live, join(dir, `auto-${i}.sbmbak`), { appVersion: '1', storeName: 's', reason: 'auto' });
    await createBackup(live, join(dir, 'manual.sbmbak'), { appVersion: '1', storeName: 's', reason: 'manual' });
    const { info } = validateBackup(join(dir, 'manual.sbmbak'), dir);
    expect(info.counts?.sales).toBe(5);
    expect(pruneBackups(dir, 2)).toBe(2);
    expect(listBackups(dir).length).toBe(3);
    live.close();
  });
});
