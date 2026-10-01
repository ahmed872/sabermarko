import Database from 'better-sqlite3';
import { MIGRATIONS } from './schema';
import { APP_ID } from '../../shared/brand';

export type DB = Database.Database;

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Opens the database with durability-focused pragmas:
 *  - WAL journal: crash/power-loss safe, readers do not block the writer
 *  - synchronous=FULL: a committed transaction survives power loss
 *  - foreign_keys=ON: no orphan records
 */
export function openDatabase(file: string, opts: { readonly?: boolean } = {}): DB {
  const db = new Database(file, { readonly: !!opts.readonly, fileMustExist: !!opts.readonly });
  if (!opts.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function migrate(db: DB): { from: number; to: number } {
  const from = db.pragma('user_version', { simple: true }) as number;
  if (from > SCHEMA_VERSION) {
    throw new Error(`Database schema v${from} is newer than app schema v${SCHEMA_VERSION}`);
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('app_id', ?) ON CONFLICT(key) DO NOTHING`).run(APP_ID);
  db.prepare(`INSERT INTO app_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
  return { from, to: SCHEMA_VERSION };
}

export function quickCheck(db: DB): boolean {
  const rows = db.pragma('quick_check') as { quick_check: string }[];
  return rows.length === 1 && rows[0].quick_check === 'ok';
}
