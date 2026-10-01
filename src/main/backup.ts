import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCb, gzip as gzipCb } from 'node:zlib';
import Database from 'better-sqlite3';
import { APP_ID } from '../shared/brand';
import { AppError } from '../shared/errors';
import { SCHEMA_VERSION, type DB } from './db/connection';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/**
 * Backup container format (.sbmbak):
 *   line 1: "SBMBAK1"
 *   line 2: JSON header (metadata only — never secrets)
 *   rest  : gzip(SQLite database snapshot)
 * The SHA-256 covers the gzip payload, so any corruption is detected before restore.
 * Compression runs on the libuv thread pool so the app never freezes while backing up.
 *
 * Version policy:
 *   - backup schema == app schema  -> restored as is
 *   - backup schema  < app schema  -> restored, then migrated forward automatically (migrations are append-only)
 *   - backup schema  > app schema  -> refused (BACKUP_NEWER): update the program first
 */
const MAGIC = 'SBMBAK1';

export type BackupType = 'manual' | 'auto' | 'day-close' | 'before-restore' | 'before-update' | 'export';

export interface BackupHeader {
  app: string;
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  storeId?: string; // installation/store UUID (absent in backups made before v1 of this field)
  storeName: string;
  reason?: BackupType | string; // backup type
  sha256: string;
  size: number;
}

export interface BackupCounts { products: number; sales: number; purchases: number; customers: number; suppliers: number; users: number; stock_movements: number }
export interface BackupInfo extends BackupHeader { file: string; fileSize: number; counts?: BackupCounts; verified?: boolean; migrationNeeded?: boolean }

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function backupFileName(storeName: string, d = new Date()): string {
  const safe = (storeName || 'store').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  return `${safe}-${stamp(d)}.sbmbak`;
}

/** The installation's store identity (created once, kept across restores of its own backups). */
export function storeIdOf(db: DB): string {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'store_uid'`).get() as { value: string } | undefined;
  if (row) return row.value;
  const id = randomUUID();
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('store_uid', ?) ON CONFLICT(key) DO NOTHING`).run(id);
  return id;
}

export async function createBackup(
  db: DB,
  destFile: string,
  meta: { appVersion: string; storeName: string; reason?: BackupType; verify?: boolean; workDir?: string },
): Promise<BackupInfo> {
  mkdirSync(dirname(destFile), { recursive: true });
  const snap = `${destFile}.snapshot.tmp`;
  try {
    await db.backup(snap); // consistent online snapshot, copied in small steps (safe while the app is in use)
    const raw = await readFile(snap);
    const payload = await gzip(raw, { level: 6 });
    const header: BackupHeader = {
      app: APP_ID,
      schemaVersion: db.pragma('user_version', { simple: true }) as number,
      appVersion: meta.appVersion,
      createdAt: new Date().toISOString(),
      storeId: storeIdOf(db),
      storeName: meta.storeName,
      reason: meta.reason ?? 'manual',
      sha256: createHash('sha256').update(payload).digest('hex'),
      size: raw.length,
    };
    const tmp = `${destFile}.tmp`;
    await writeFile(tmp, Buffer.concat([Buffer.from(`${MAGIC}\n${JSON.stringify(header)}\n`, 'utf8'), payload]));
    renameSync(tmp, destFile);
    if (meta.verify !== false) {
      // full verification of what was written: checksum, gzip, SQLite integrity, app id, version, row counts
      const { info, dbFile } = await validateBackup(destFile, meta.workDir ?? dirname(destFile));
      try { unlinkSync(dbFile); } catch { /* ignore */ }
      return { ...info, verified: true };
    }
    const h = await readHeader(destFile);
    return { ...h, file: destFile, fileSize: statSync(destFile).size };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('BACKUP_FAILED');
  } finally {
    try { if (existsSync(snap)) unlinkSync(snap); } catch { /* ignore */ }
  }
}

function split(buf: Buffer): { header: BackupHeader; payload: Buffer } {
  const first = buf.indexOf(0x0a);
  const second = first >= 0 ? buf.indexOf(0x0a, first + 1) : -1;
  if (first < 0 || second < 0 || first > 32 || second - first > 64 * 1024) throw new AppError('BACKUP_INVALID');
  if (buf.subarray(0, first).toString('utf8') !== MAGIC) throw new AppError('BACKUP_INVALID');
  let header: BackupHeader;
  try { header = JSON.parse(buf.subarray(first + 1, second).toString('utf8')); } catch { throw new AppError('BACKUP_INVALID'); }
  if (!header || typeof header !== 'object' || typeof header.sha256 !== 'string') throw new AppError('BACKUP_INVALID');
  return { header, payload: buf.subarray(second + 1) };
}

async function readBuf(file: string): Promise<Buffer> {
  try { return await readFile(file); } catch { throw new AppError('BACKUP_INVALID'); }
}

export async function readHeader(file: string): Promise<BackupHeader> {
  const { header, payload } = split(await readBuf(file));
  if (header.app !== APP_ID) throw new AppError('BACKUP_INVALID');
  if (createHash('sha256').update(payload).digest('hex') !== header.sha256) throw new AppError('BACKUP_INVALID');
  return header;
}

const COUNT_TABLES: (keyof BackupCounts)[] = ['products', 'sales', 'purchases', 'customers', 'suppliers', 'users', 'stock_movements'];

/**
 * Fully validates a backup and extracts it to a temporary SQLite file:
 * magic, checksum, gzip, size, SQLite integrity_check + foreign_key_check,
 * app id and schema version.
 */
export async function validateBackup(file: string, workDir: string): Promise<{ info: BackupInfo; dbFile: string }> {
  const buf = await readBuf(file);
  const { header, payload } = split(buf);
  if (header.app !== APP_ID) throw new AppError('BACKUP_INVALID');
  if (createHash('sha256').update(payload).digest('hex') !== header.sha256) throw new AppError('BACKUP_INVALID');
  if (header.schemaVersion > SCHEMA_VERSION) throw new AppError('BACKUP_NEWER');
  let raw: Buffer;
  try { raw = await gunzip(payload); } catch { throw new AppError('BACKUP_INVALID'); }
  if (raw.length !== header.size) throw new AppError('BACKUP_INVALID');
  mkdirSync(workDir, { recursive: true });
  const dbFile = join(workDir, `restore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  await writeFile(dbFile, raw);
  let check: Database.Database | null = null;
  try {
    check = new Database(dbFile, { readonly: true, fileMustExist: true });
    const ic = check.pragma('integrity_check') as { integrity_check: string }[];
    if (ic.length !== 1 || ic[0].integrity_check !== 'ok') throw new AppError('BACKUP_INVALID');
    if ((check.pragma('foreign_key_check') as unknown[]).length) throw new AppError('BACKUP_INVALID');
    const appId = (check.prepare(`SELECT value FROM app_meta WHERE key = 'app_id'`).get() as { value: string } | undefined)?.value;
    if (appId !== APP_ID) throw new AppError('BACKUP_INVALID');
    const uv = check.pragma('user_version', { simple: true }) as number;
    if (uv > SCHEMA_VERSION) throw new AppError('BACKUP_NEWER');
    if (uv !== header.schemaVersion) throw new AppError('BACKUP_INVALID');
    const counts = {} as BackupCounts;
    for (const t of COUNT_TABLES) counts[t] = (check.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    check.close();
    check = null;
    return { info: { ...header, file, fileSize: buf.length, counts, migrationNeeded: uv < SCHEMA_VERSION }, dbFile };
  } catch (e) {
    try { check?.close(); } catch { /* ignore */ }
    try { unlinkSync(dbFile); } catch { /* ignore */ }
    if (e instanceof AppError) throw e;
    throw new AppError('BACKUP_INVALID');
  }
}

/**
 * Restores a validated backup over the live database file.
 * Order is deliberate and never destroys current data first:
 *   1. validate the incoming file completely
 *   2. take a verified safety backup of the CURRENT database
 *   3. swap files atomically, reopen (runs forward migrations), verify
 *   4. on any failure put the previous database back
 */
export async function restoreBackup(opts: {
  file: string; dbPath: string; workDir: string; db: DB; close: () => void; reopen: () => DB; appVersion: string; storeName: string;
  /** where the automatic "before restore" copy is kept — the visible backup folder, so a wrong restore can be undone */
  safetyDir?: string;
}): Promise<{ info: BackupInfo; safetyFile: string; after: BackupCounts }> {
  const { info, dbFile } = await validateBackup(opts.file, opts.workDir);
  let safetyFile = '';
  try {
    if (opts.safetyDir) mkdirSync(opts.safetyDir, { recursive: true });
    safetyFile = join(opts.safetyDir ?? opts.workDir, `before-restore-${stamp()}.sbmbak`);
    await createBackup(opts.db, safetyFile, { appVersion: opts.appVersion, storeName: opts.storeName, reason: 'before-restore', workDir: opts.workDir });
  } catch (e) {
    try { unlinkSync(dbFile); } catch { /* ignore */ }
    throw e;
  }
  const liveCopy = join(opts.workDir, `live-${Date.now()}.db`);
  opts.db.pragma('wal_checkpoint(TRUNCATE)');
  opts.close();
  try {
    copyFileSync(opts.dbPath, liveCopy);
    for (const ext of ['-wal', '-shm']) { try { rmSync(opts.dbPath + ext, { force: true }); } catch { /* ignore */ } }
    copyFileSync(dbFile, `${opts.dbPath}.restore.tmp`);
    renameSync(`${opts.dbPath}.restore.tmp`, opts.dbPath);
    const fresh = opts.reopen(); // runs forward migrations for older backups; throws if unusable
    const ok = (fresh.pragma('quick_check') as { quick_check: string }[])[0]?.quick_check === 'ok';
    if (!ok) throw new Error('restored database failed quick_check');
    const after = {} as BackupCounts;
    for (const t of COUNT_TABLES) after[t] = (fresh.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    for (const t of COUNT_TABLES) if (after[t] !== info.counts![t]) throw new Error(`row count mismatch on ${t}`);
    return { info, safetyFile, after };
  } catch {
    try {
      try { opts.close(); } catch { /* may already be closed */ }
      for (const ext of ['-wal', '-shm']) { try { rmSync(opts.dbPath + ext, { force: true }); } catch { /* ignore */ } }
      copyFileSync(liveCopy, opts.dbPath);
      opts.reopen();
    } catch { /* surfaced by caller */ }
    throw new AppError('RESTORE_FAILED');
  } finally {
    try { unlinkSync(dbFile); } catch { /* ignore */ }
    try { unlinkSync(liveCopy); } catch { /* ignore */ }
  }
}

export async function listBackups(dir: string): Promise<BackupInfo[]> {
  if (!existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sbmbak')) continue;
    const file = join(dir, f);
    try {
      const h = await readHeader(file);
      out.push({ ...h, file, fileSize: statSync(file).size });
    } catch {
      out.push({ app: '', schemaVersion: 0, appVersion: '', createdAt: statSync(file).mtime.toISOString(), storeName: basename(f), sha256: '', size: 0, file, fileSize: statSync(file).size, reason: 'invalid' });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keep the newest `keep` automatic backups. Manual backups are never pruned. */
export async function pruneBackups(dir: string, keep: number): Promise<number> {
  const autos = (await listBackups(dir)).filter((b) => b.reason === 'auto' || b.reason === 'day-close');
  let removed = 0;
  for (const b of autos.slice(Math.max(keep, 1))) {
    try { unlinkSync(b.file); removed++; } catch { /* ignore */ }
  }
  return removed;
}
