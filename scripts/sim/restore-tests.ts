/**
 * BACKUP / RESTORE / RECOVERY / PERFORMANCE tests on the one-year simulation output.
 * Every restore happens in its own throw-away folder — never on the simulation's
 * own database and never anywhere near a real installation.
 *
 *   node dist/sim/restore-tests.js --out sim-output
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { openDatabase, migrate, quickCheck, SCHEMA_VERSION, type DB } from '../../src/main/db/connection';
import { MIGRATIONS } from '../../src/main/db/schema';
import { seedSystemData } from '../../src/main/db/seed';
import { createBackup, restoreBackup, validateBackup } from '../../src/main/backup';
import { errorMessage } from '../../src/shared/errors';
import { APP_ID } from '../../src/shared/brand';
import type { Ctx } from '../../src/main/services/context';
import { login } from '../../src/main/services/users';
import { posSearch, listProducts } from '../../src/main/services/products';
import { checkout } from '../../src/main/services/sales';
import { openShift } from '../../src/main/services/shifts';
import { financialSummary, dashboard, productPerformance, inventoryValuation, dayClosingPreview } from '../../src/main/services/reports';
import { listSales } from '../../src/main/services/sales';
import { productMetrics } from '../../src/main/services/analytics';
import { generateSuggestions } from '../../src/main/services/recommendations';

const args = process.argv.slice(2);
const OUT = resolve(args[args.indexOf('--out') + 1] ?? 'sim-output');
const WORK = join(OUT, 'restore-tests');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const sim = JSON.parse(readFileSync(join(OUT, 'sim-log.json'), 'utf8'));
const results: any = { backups: {}, restores: [], corruption: [], recovery: [], performance: {}, oldVersion: null };
const ms = (t0: number) => Math.round(performance.now() - t0);

/** content hash of every table (row order by rowid) — used to prove "restored == original" */
function tableHashes(db: DB): Record<string, string> {
  const out: Record<string, string> = {};
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[];
  for (const { name } of tables) {
    const h = createHash('sha256');
    for (const row of db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) h.update(JSON.stringify(row));
    out[name] = h.digest('hex').slice(0, 16);
  }
  return out;
}
function diffHashes(a: Record<string, string>, b: Record<string, string>, ignore: string[] = []) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((t) => !ignore.includes(t) && a[t] !== b[t]);
}
/** a separate "installation": its own folder + database */
function freshInstall(name: string, withStore = true) {
  const dir = join(WORK, name);
  mkdirSync(join(dir, 'work'), { recursive: true });
  const dbPath = join(dir, 'store.db');
  const env = { dir, dbPath, db: openDatabase(dbPath) };
  migrate(env.db); seedSystemData(env.db);
  if (withStore) env.db.prepare(`INSERT INTO settings(key, value) VALUES ('store.name', '"بيانات حالية أخرى"') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
  return env;
}
async function restoreInto(env: { dir: string; dbPath: string; db: DB }, file: string) {
  const t0 = performance.now();
  const r = await restoreBackup({
    file, dbPath: env.dbPath, workDir: join(env.dir, 'work'), safetyDir: join(env.dir, 'backups'), db: env.db, appVersion: '1.0.0', storeName: 'اختبار',
    close: () => env.db.close(), reopen: () => { env.db = openDatabase(env.dbPath); migrate(env.db); return env.db; },
  });
  return { ...r, ms: ms(t0) };
}

(async () => {
  /* ---------------------------------------------------------------- 1. every backup on disk validates */
  const files: string[] = [];
  for (const sub of ['daily', 'weekly', 'monthly', 'milestones']) for (const f of readdirSync(join(OUT, 'backups', sub))) files.push(join(OUT, 'backups', sub, f));
  let valid = 0; let largest = { file: '', size: 0 }; let totalBytes = 0; let validateMs = 0;
  const invalid: string[] = [];
  for (const f of files) {
    const size = statSync(f).size; totalBytes += size;
    if (size > largest.size) largest = { file: basename(f), size };
    const t0 = performance.now();
    try { const { dbFile } = await validateBackup(f, join(WORK)); rmSync(dbFile, { force: true }); valid++; } catch { invalid.push(basename(f)); }
    validateMs += performance.now() - t0;
  }
  const made = sim.backups as any[];
  results.backups = {
    createdDuringYear: made.length, verifiedAtCreation: made.filter((b) => b.verified).length, failedAtCreation: sim.counts['backups.failed'] ?? 0,
    keptOnDisk: files.length, validOnDisk: valid, invalidOnDisk: invalid, largest, totalBytes,
    avgCreateMs: Math.round(made.reduce((a, b) => a + b.ms, 0) / made.length), maxCreateMs: Math.max(...made.map((b) => b.ms)),
    firstSize: made[0]?.size, lastSize: made.at(-1)?.size, avgValidateMs: Math.round(validateMs / Math.max(1, files.length)),
    retention: { daily: readdirSync(join(OUT, 'backups', 'daily')).length, weekly: readdirSync(join(OUT, 'backups', 'weekly')).length, monthly: readdirSync(join(OUT, 'backups', 'monthly')).length },
  };
  console.log('backups', JSON.stringify(results.backups));

  /* ---------------------------------------------------------------- 2. milestone restores into separate installations */
  const original = openDatabase(join(OUT, 'store.db'), { readonly: true });
  const originalHashes = tableHashes(original);
  for (const label of ['day-001', 'month-01', 'month-06', 'month-12']) {
    const file = sim.milestones[label];
    const env = freshInstall(`restore-${label}`);
    const r: any = { label, file: basename(file), ok: false };
    try {
      const res = await restoreInto(env, file);
      r.ms = res.ms; r.counts = res.after; r.safetyKept = existsSync(res.safetyFile);
      // restored content == the snapshot inside the backup, table by table
      const { dbFile } = await validateBackup(file, WORK);
      const snap = openDatabase(dbFile, { readonly: true });
      r.tablesDifferentFromBackup = diffHashes(tableHashes(snap), tableHashes(env.db));
      snap.close(); rmSync(dbFile, { force: true });
      r.quickCheck = quickCheck(env.db);
      r.fkViolations = (env.db.pragma('foreign_key_check') as unknown[]).length;
      if (label === 'month-12') r.tablesDifferentFromLiveStore = diffHashes(originalHashes, tableHashes(env.db));
      // the restored store is usable: the owner logs in and a cashier-free sale works
      const ctx: Ctx = { db: env.db, user: null, now: () => new Date(2026, 9, 1, 9) };
      ctx.user = login(ctx, 'owner', 'owner-pass');
      openShift(ctx, { openingCash: 0 });
      const p = env.db.prepare(`SELECT p.id, p.base_unit_id FROM products p JOIN product_stock s ON s.product_id = p.id WHERE s.qty >= 1000 AND p.is_weighted = 0 AND s.location_id = (SELECT id FROM locations WHERE is_default = 1) LIMIT 1`).get() as any;
      const sale: any = checkout(ctx, { cart: { lines: [{ productId: p.id, unitId: p.base_unit_id, qty: 1000 }] }, payments: [{ method: 'cash', amount: 1_000_000 }] });
      r.saleAfterRestore = sale.invoice_no;
      r.ok = r.quickCheck && r.fkViolations === 0 && r.tablesDifferentFromBackup.length === 0 && (label !== 'month-12' || r.tablesDifferentFromLiveStore.length === 0);
    } catch (e: any) { r.error = e?.code ?? String(e); }
    env.db.close();
    results.restores.push(r);
    console.log('restore', JSON.stringify(r).slice(0, 400));
  }

  /* ---------------------------------------------------------------- 3. damaged / foreign / newer backups are refused, current data untouched */
  const good = readFileSync(sim.milestones['month-12']);
  const text = good.toString('latin1'); const nl1 = text.indexOf('\n'); const nl2 = text.indexOf('\n', nl1 + 1);
  const header = JSON.parse(good.subarray(nl1 + 1, nl2).toString('utf8'));
  const withHeader = (h: object) => Buffer.concat([good.subarray(0, nl1 + 1), Buffer.from(JSON.stringify(h)), good.subarray(nl2)]);
  const cases: [string, Buffer][] = [
    ['بايت تالف في منتصف الملف', (() => { const b = Buffer.from(good); b[Math.floor(b.length / 2)] ^= 0xff; return b; })()],
    ['ملف مقطوع (نسخ لم يكتمل)', good.subarray(0, Math.floor(good.length * 0.6))],
    ['ملف عشوائي بامتداد النسخة', Buffer.alloc(200_000, 0x5a)],
    ['ملف فارغ', Buffer.alloc(0)],
    ['نسخة من برنامج آخر', withHeader({ ...header, app: 'other.app' })],
    ['نسخة من إصدار أحدث من البرنامج', withHeader({ ...header, schemaVersion: SCHEMA_VERSION + 1 })],
  ];
  const victim = freshInstall('corruption-victim');
  const vctx: Ctx = { db: victim.db, user: null, now: () => new Date() };
  void vctx;
  const before = tableHashes(victim.db);
  for (const [name, buf] of cases) {
    const f = join(WORK, `case-${results.corruption.length}.sbmbak`);
    writeFileSync(f, buf);
    const r: any = { case: name, refused: false };
    try { await restoreInto(victim, f); r.refused = false; } catch (e: any) { r.refused = true; r.code = e?.code ?? String(e); r.message = errorMessage(r.code); }
    r.liveDataUntouched = diffHashes(before, tableHashes(victim.db)).length === 0;
    r.liveDbUsable = victim.db.open && quickCheck(victim.db);
    results.corruption.push(r);
    console.log('corrupt', JSON.stringify(r));
  }
  victim.db.close();

  /* ---------------------------------------------------------------- 4. old-version (schema v1) backup on this version */
  {
    const oldDir = join(WORK, 'old-version'); mkdirSync(oldDir, { recursive: true });
    const old = openDatabase(join(oldDir, 'v1.db'));
    old.exec(MIGRATIONS[0]); old.pragma('user_version = 1'); seedSystemData(old);
    old.prepare(`INSERT INTO app_meta(key, value) VALUES ('app_id', ?)`).run(APP_ID);
    old.prepare(`INSERT INTO promotions(name, type, min_qty, value, active, created_at) VALUES ('عرض من الإصدار القديم', 'percent', 1000, 1000, 1, '2025-01-01 10:00:00')`).run();
    const f = join(oldDir, 'v1.sbmbak');
    await createBackup(old, f, { appVersion: '0.9.0', storeName: 'محل بإصدار قديم' });
    old.close();
    const env = freshInstall('old-version-target');
    const r: any = { from: 'schema v1 (app 0.9.0)', to: `schema v${SCHEMA_VERSION}` };
    try {
      const res = await restoreInto(env, f);
      r.ok = true; r.ms = res.ms; r.migrationNeeded = res.info.migrationNeeded;
      r.schemaAfter = env.db.pragma('user_version', { simple: true });
      r.promotionKept = (env.db.prepare('SELECT name FROM promotions').get() as any)?.name;
    } catch (e: any) { r.ok = false; r.error = e?.code ?? String(e); }
    env.db.close();
    results.oldVersion = r;
    console.log('old-version', JSON.stringify(r));
  }

  /* ---------------------------------------------------------------- 5. recovery scenarios */
  {
    // (a) the computer died: brand-new install with no store at all, restore the latest backup
    const env = freshInstall('new-computer', false);
    const r: any = { scenario: 'جهاز جديد بدون أي بيانات + استعادة آخر نسخة' };
    try {
      const res = await restoreInto(env, sim.milestones['month-12']);
      const ctx: Ctx = { db: env.db, user: null, now: () => new Date(2026, 9, 1, 9) };
      ctx.user = login(ctx, 'owner', 'owner-pass');
      r.ok = true; r.ms = res.ms; r.invoices = res.after.sales; r.ownerLogin = !!ctx.user;
    } catch (e: any) { r.ok = false; r.error = e?.code ?? String(e); }
    env.db.close();
    results.recovery.push(r);
  }
  {
    // (b) wrong backup restored by mistake (month 6 over the full year), then undone from the automatic safety copy
    const env = freshInstall('wrong-backup');
    env.db.close(); copyFileSync(join(OUT, 'store.db'), env.dbPath); env.db = openDatabase(env.dbPath); migrate(env.db);
    const yearHashes = tableHashes(env.db);
    const r: any = { scenario: 'استعادة نسخة خاطئة (الشهر 6) فوق بيانات السنة ثم التراجع من نسخة الأمان' };
    try {
      const wrong = await restoreInto(env, sim.milestones['month-06']);
      r.afterWrongRestoreInvoices = wrong.after.sales;
      r.safetyCopyInBackupFolder = wrong.safetyFile.startsWith(join(env.dir, 'backups'));
      const undo = await restoreInto(env, wrong.safetyFile);
      r.afterUndoInvoices = undo.after.sales;
      r.tablesDifferentFromBeforeMistake = diffHashes(yearHashes, tableHashes(env.db), ['app_meta']);
      r.ok = r.tablesDifferentFromBeforeMistake.length === 0;
    } catch (e: any) { r.ok = false; r.error = e?.code ?? String(e); }
    env.db.close();
    results.recovery.push(r);
  }
  console.log('recovery', JSON.stringify(results.recovery));

  /* ---------------------------------------------------------------- 6. performance with one year of data */
  {
    const dir = join(WORK, 'perf'); mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'store.db');
    copyFileSync(join(OUT, 'store.db'), dbPath);
    const t0 = performance.now();
    const db = openDatabase(dbPath); migrate(db); const qc = quickCheck(db);
    const open = ms(t0);
    const ctx: Ctx = { db, user: null, now: () => new Date(2026, 8, 30, 20) };
    ctx.user = login(ctx, 'owner', 'owner-pass');
    const time = (fn: () => unknown, n = 1) => { const t = performance.now(); for (let i = 0; i < n; i++) fn(); return Math.round(((performance.now() - t) / n) * 100) / 100; };
    const anyName = (db.prepare('SELECT name FROM products ORDER BY id DESC LIMIT 1').get() as any).name.split(' ')[0];
    const perf: any = {
      dbBytes: statSync(dbPath).size, openMigrateQuickCheckMs: open, quickCheck: qc,
      rows: Object.fromEntries(['products', 'sales', 'sale_items', 'stock_movements', 'audit_log', 'batches'].map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n])),
      posSearchTextMs: time(() => posSearch(ctx, anyName), 50),
      productsListMs: time(() => listProducts(ctx, {}), 10),
      salesListMs: time(() => listSales(ctx, { from: '2026-09-01', to: '2026-09-30' }), 10),
      yearSummaryMs: time(() => financialSummary(ctx, '2025-10-01', '2026-09-30'), 5),
      dashboardMs: time(() => dashboard(ctx), 5),
      productPerformanceYearMs: time(() => productPerformance(ctx, '2025-10-01', '2026-09-30', { sort: 'profit', limit: 50 }), 3),
      valuationMs: time(() => inventoryValuation(ctx), 3),
      dayClosingPreviewMs: time(() => dayClosingPreview(ctx, '2026-09-30'), 5),
      intelMetricsMs: time(() => productMetrics(ctx), 3),
      generateSuggestionsMs: time(() => generateSuggestions(ctx), 1),
    };
    openShift(ctx, { openingCash: 0 });
    const prods = db.prepare(`SELECT p.id, p.base_unit_id FROM products p JOIN product_stock s ON s.product_id = p.id AND s.location_id = (SELECT id FROM locations WHERE is_default = 1) WHERE s.qty >= 50000 AND p.is_weighted = 0 LIMIT 20`).all() as any[];
    const lat: number[] = [];
    for (let i = 0; i < 300; i++) {
      const p = prods[i % prods.length];
      const t = performance.now();
      checkout(ctx, { cart: { lines: [{ productId: p.id, unitId: p.base_unit_id, qty: 1000 }, { productId: prods[(i + 7) % prods.length].id, unitId: prods[(i + 7) % prods.length].base_unit_id, qty: 1000 }] }, payments: [{ method: 'cash', amount: 1_000_000 }] });
      lat.push(performance.now() - t);
    }
    lat.sort((a, b) => a - b);
    perf.checkoutAfterYear = { n: lat.length, avgMs: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length * 100) / 100, p95Ms: Math.round(lat[Math.floor(lat.length * 0.95)] * 100) / 100, maxMs: Math.round(lat.at(-1)! * 100) / 100 };
    const tb = performance.now();
    const info: any = await createBackup(db, join(dir, 'year.sbmbak'), { appVersion: '1.0.0', storeName: 'اختبار', workDir: dir });
    perf.backupYearMs = ms(tb); perf.backupYearBytes = statSync(join(dir, 'year.sbmbak')).size; perf.backupVerified = info.verified;
    db.close();
    const env = freshInstall('perf-restore');
    const tr = performance.now();
    await restoreInto(env, join(dir, 'year.sbmbak'));
    perf.restoreYearMs = ms(tr);
    env.db.close();
    results.performance = perf;
    console.log('performance', JSON.stringify(perf));
  }

  /* ---------------------------------------------------------------- 7. the verifier is not vacuous: tampering is detected */
  {
    const dir = join(WORK, 'tamper'); mkdirSync(dir, { recursive: true });
    const f = join(dir, 'store.db');
    copyFileSync(join(OUT, 'store.db'), f);
    const db = openDatabase(f);
    db.prepare(`UPDATE product_stock SET qty = qty + 1000 WHERE rowid = (SELECT rowid FROM product_stock WHERE qty > 5000 LIMIT 1)`).run();
    db.prepare(`UPDATE sales SET total = total + 100 WHERE id = (SELECT id FROM sales WHERE status = 'completed' ORDER BY id DESC LIMIT 1)`).run();
    db.prepare(`UPDATE customers SET balance = balance + 500 WHERE id = (SELECT id FROM customers LIMIT 1)`).run();
    db.close();
    results.tamperDb = f;
  }

  const restoresTried = results.restores.length + results.recovery.length + 1;
  const restoresOk = results.restores.filter((r: any) => r.ok).length + results.recovery.filter((r: any) => r.ok).length + (results.oldVersion?.ok ? 1 : 0);
  results.summary = {
    restoreSuccess: `${restoresOk}/${restoresTried}`,
    corruptionRefused: `${results.corruption.filter((c: any) => c.refused && c.liveDataUntouched && c.liveDbUsable).length}/${results.corruption.length}`,
    ok: restoresOk === restoresTried && results.corruption.every((c: any) => c.refused && c.liveDataUntouched && c.liveDbUsable) && results.backups.invalidOnDisk.length === 0,
  };
  original.close();
  writeFileSync(join(OUT, 'restore-report.json'), JSON.stringify(results, null, 1));
  console.log('SUMMARY', JSON.stringify(results.summary));
  process.exit(results.summary.ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
