import type { DB } from '../db/connection';
import type { Permission } from '../../shared/permissions';
import { hasPermission } from '../../shared/permissions';
import { AppError } from '../../shared/errors';
import { DEFAULT_SETTINGS, type SettingKey, type StoreSettings } from '../../shared/settings';

export interface SessionUser {
  id: number;
  username: string;
  fullName: string;
  roleCode: string;
  roleName: string;
  permissions: Permission[] | '*';
  maxDiscountPct: number | null;
}

export interface Ctx {
  db: DB;
  user: SessionUser | null;
  /** Clock; injectable for tests. */
  now: () => Date;
  /** A manager who approved a sensitive action in this request (supervisor override). */
  approver?: SessionUser | null;
  terminal?: string;
}

export function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function localTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ts(ctx: Ctx): string {
  return localTimestamp(ctx.now());
}

export function today(ctx: Ctx): string {
  return localDate(ctx.now());
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return localDate(dt);
}

export function requireUser(ctx: Ctx): SessionUser {
  if (!ctx.user) throw new AppError('NOT_AUTHENTICATED');
  return ctx.user;
}

export function can(ctx: Ctx, p: Permission): boolean {
  return !!ctx.user && hasPermission(ctx.user.permissions, p);
}

/** Throws FORBIDDEN unless the user (or an approving manager) has the permission. */
export function requirePerm(ctx: Ctx, p: Permission): void {
  requireUser(ctx);
  if (can(ctx, p)) return;
  if (ctx.approver && hasPermission(ctx.approver.permissions, p)) return;
  throw new AppError('FORBIDDEN');
}

/** Like requirePerm but signals the UI that a manager approval can unlock it. */
export function requirePermOrApproval(ctx: Ctx, p: Permission): number | null {
  requireUser(ctx);
  if (can(ctx, p)) return null;
  if (ctx.approver && hasPermission(ctx.approver.permissions, p)) return ctx.approver.id;
  throw new AppError('APPROVAL_REQUIRED', { permission: p });
}

const settingsCache = new WeakMap<DB, Map<string, unknown>>();

export function getSetting<K extends SettingKey>(db: DB, key: K): StoreSettings[K] {
  let cache = settingsCache.get(db);
  if (!cache) {
    cache = new Map();
    for (const row of db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
      try { cache.set(row.key, JSON.parse(row.value)); } catch { /* ignore corrupt value */ }
    }
    settingsCache.set(db, cache);
  }
  return (cache.has(key) ? cache.get(key) : DEFAULT_SETTINGS[key]) as StoreSettings[K];
}

export function getAllSettings(db: DB): StoreSettings {
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(db, k as SettingKey);
  return out as unknown as StoreSettings;
}

export function setSettingRaw(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  settingsCache.delete(db);
}

export function invalidateSettings(db: DB): void {
  settingsCache.delete(db);
}

/** Atomically allocate the next number of a named sequence. Call inside a transaction. */
export function nextSeq(db: DB, name: string): number {
  db.prepare('INSERT INTO sequences(name, next_value) VALUES (?, 1) ON CONFLICT(name) DO NOTHING').run(name);
  const row = db.prepare('UPDATE sequences SET next_value = next_value + 1 WHERE name = ? RETURNING next_value - 1 AS v').get(name) as { v: number };
  return row.v;
}

export function docNo(db: DB, name: string, prefix: string, width = 6): string {
  return `${prefix}${pad(nextSeq(db, name), width)}`;
}

export function audit(ctx: Ctx, action: string, entity: string | null, entityId: number | null, oldValue?: unknown, newValue?: unknown, reason?: string | null, approvedBy?: number | null): void {
  ctx.db.prepare(
    `INSERT INTO audit_log(user_id, approved_by, action, entity, entity_id, old_value, new_value, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ctx.user?.id ?? null,
    approvedBy ?? null,
    action,
    entity,
    entityId,
    oldValue === undefined ? null : JSON.stringify(oldValue),
    newValue === undefined ? null : JSON.stringify(newValue),
    reason ?? null,
    ts(ctx),
  );
}

export function defaultLocationId(db: DB): number {
  const row = db.prepare('SELECT id FROM locations WHERE is_default = 1 AND active = 1 ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  if (!row) throw new AppError('NOT_FOUND');
  return row.id;
}

export function tx<T>(ctx: Ctx, fn: () => T): T {
  return ctx.db.transaction(fn)();
}
