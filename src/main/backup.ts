import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { APP_ID } from '../shared/brand';
import { AppError } from '../shared/errors';
import { SCHEMA_VERSION, type DB } from './db/connection';

/**
 * Backup container format (.sbmbak):
 *   line 1: "SBMBAK1"
 *   line 2: JSON header { app, schemaVersion, appVersion, createdAt, storeName, sha256, size }
 *   rest  : gzip(SQLite database snapshot)
 * The SHA-256 covers the gzip payload, so any corruption is detected before restore.
 */
const MAGIC = 'SBMBAK1';

export interface BackupHeader {
  app: string; schemaVersion: number; appVersion: string; createdAt: string; storeName: string; sha256: string; size: number; reason?: string;
}

export interface BackupInfo extends BackupHeader { file: string; fileSize: number; counts?: Record<string, number> }

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function backupFileName(storeName: string, d = new Date()): string {
  const safe = (storeName || 'store').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  return `${safe}-${stamp(d)}.sbmbak`;
}

export async function createBackup(db: DB, destFile: string, meta: { appVersion: string; storeName: string; reason?: string }): Promise<BackupInfo> {
  mkdirSync(dirname(destFile), { recursive: true });
  const snap = `${destFile}.snapshot.tmp`;
  try {
    await db.backup(snap); // consistent online snapshot (safe while the app is in use)
    const raw = readFileSync(snap);
    const payload = gzipSync(raw, { level: 6 });
    const header: BackupHeader = {
      app: APP_ID, schemaVersion: SCHEMA_VERSION, appVersion: meta.appVersion, createdAt: new Date().toISOString(),
      storeName: meta.storeName, sha256: createHash('sha256').update(payload).digest('hex'), size: raw.length, reason: meta.reason,
    };
    const tmp = `${destFile}.tmp`;
    writeFileSync(tmp, Buffer.concat([Buffer.from(`${MAGIC}\n${JSON.stringify(header)}\n`, 'utf8'), payload]));
    renameSync(tmp, destFile);
    // verify what was written
    const info = readHeader(destFile);
    return { ...info, file: destFile, fileSize: statSync(destFile).size };
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
  if (first < 0 || second < 0) throw new AppError('BACKUP_INVALID');
  if (buf.subarray(0, first).toString('utf8') !== MAGIC) throw new AppError('BACKUP_INVALID');
  let header: BackupHeader;
  try { header = JSON.parse(buf.subarray(first + 1, second).toString('utf8')); } catch { throw new AppError('BACKUP_INVALID'); }
  return { header, payload: buf.subarray(second + 1) };
}

export function readHeader(file: string): BackupHeader {
  let buf: Buffer;
  try { buf = readFileSync(file); } catch { throw new AppError('BACKUP_INVALID'); }
  const { header, payload } = split(buf);
  if (header.app !== APP_ID) throw new AppError('BACKUP_INVALID');
  if (createHash('sha256').update(payload).digest('hex') !== header.sha256) throw new AppError('BACKUP_INVALID');
  return header;
}

/**
 * Fully validates a backup and extracts it to a temporary SQLite file:
 * magic, checksum, gzip, SQLite integrity_check, app id and schema version.
 */
export function validateBackup(file: string, workDir: string): { info: BackupInfo; dbFile: string } {
  let buf: Buffer;
  try { buf = readFileSync(file); } catch { throw new AppError('BACKUP_INVALID'); }
  const { header, payload } = split(buf);
  if (header.app !== APP_ID) throw new AppError('BACKUP_INVALID');
  if (createHash('sha256').update(payload).digest('hex') !== header.sha256) throw new AppError('BACKUP_INVALID');
  if (header.schemaVersion > SCHEMA_VERSION) throw new AppError('BACKUP_NEWER');
  let raw: Buffer;
  try { raw = gunzipSync(payload); } catch { throw new AppError('BACKUP_INVALID'); }
  if (raw.length !== header.size) throw new AppError('BACKUP_INVALID');
  mkdirSync(workDir, { recursive: true });
  const dbFile = join(workDir, `restore-${Date.now()}.db`);
  writeFileSync(dbFile, raw);
  let check: Database.Database | null = null;
  try {
    check = new Database(dbFile, { readonly: true, fileMustExist: true });
    const ic = check.pragma('integrity_check') as { integrity_check: string }[];
    if (ic.length !== 1 || ic[0].integrity_check !== 'ok') throw new AppError('BACKUP_INVALID');
    const appId = (check.prepare(`SELECT value FROM app_meta WHERE key = 'app_id'`).get() as { value: string } | undefined)?.value;
    if (appId !== APP_ID) throw new AppError('BACKUP_INVALID');
    const uv = check.pragma('user_version', { simple: true }) as number;
    if (uv > SCHEMA_VERSION) throw new AppError('BACKUP_NEWER');
    const counts: Record<string, number> = {};
    for (const t of ['products', 'sales', 'purchases', 'customers', 'suppliers', 'users']) {
      counts[t] = (check.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    }
    check.close();
    check = null;
    return { info: { ...header, file, fileSize: buf.length, counts }, dbFile };
  } catch (e) {
    try { check?.close(); } catch { /* ignore */ }
    try { unlinkSync(dbFile); } catch { /* ignore */ }
    if (e instanceof AppError) throw e;
    throw new AppError('BACKUP_INVALID');
  }
}

/**
 * Restores a validated backup over the live database file. A safety copy of
 * the current database is taken first and put back if anything fails, so a
 * failed restore never leaves the store without its data.
 */
export async function restoreBackup(opts: {
  file: string; dbPath: string; workDir: string; db: DB; close: () => void; reopen: () => DB; appVersion: string; storeName: string;
}): Promise<{ info: BackupInfo; safetyFile: string }> {
  const { info, dbFile } = validateBackup(opts.file, opts.workDir);
  const safetyFile = join(opts.workDir, `before-restore-${stamp()}.sbmbak`);
  await createBackup(opts.db, safetyFile, { appVersion: opts.appVersion, storeName: opts.storeName, reason: 'before-restore' });
  const liveCopy = join(opts.workDir, `live-${Date.now()}.db`);
  opts.db.pragma('wal_checkpoint(TRUNCATE)');
  opts.close();
  try {
    copyFileSync(opts.dbPath, liveCopy);
    for (const ext of ['-wal', '-shm']) { try { rmSync(opts.dbPath + ext, { force: true }); } catch { /* ignore */ } }
    copyFileSync(dbFile, `${opts.dbPath}.restore.tmp`);
    renameSync(`${opts.dbPath}.restore.tmp`, opts.dbPath);
    opts.reopen(); // runs migrations; throws if the file is unusable
    return { info, safetyFile };
  } catch {
    try {
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

export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sbmbak')) continue;
    const file = join(dir, f);
    try {
      const h = readHeader(file);
      out.push({ ...h, file, fileSize: statSync(file).size });
    } catch {
      out.push({ app: '', schemaVersion: 0, appVersion: '', createdAt: statSync(file).mtime.toISOString(), storeName: basename(f), sha256: '', size: 0, file, fileSize: statSync(file).size, reason: 'invalid' });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keep the newest `keep` automatic backups. Manual backups are never pruned. */
export function pruneBackups(dir: string, keep: number): number {
  const autos = listBackups(dir).filter((b) => b.reason === 'auto' || b.reason === 'day-close');
  let removed = 0;
  for (const b of autos.slice(Math.max(keep, 1))) {
    try { unlinkSync(b.file); removed++; } catch { /* ignore */ }
  }
  return removed;
}
