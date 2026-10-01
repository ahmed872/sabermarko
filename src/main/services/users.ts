import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../shared/errors';
import { ALL_PERMISSIONS, type Permission } from '../../shared/permissions';
import { roleInput, userInput } from '../../shared/schemas';
import { DEFAULT_MAX_USERS } from '../../shared/license-policy';
import { type Ctx, type SessionUser, audit, requirePerm, ts, tx } from './context';

const SCRYPT_N = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface UserRow {
  id: number; username: string; full_name: string; password_hash: string; role_id: number; max_discount_pct: number | null; active: number;
  failed_attempts: number; locked_until: string | null; role_code: string; role_name: string; permissions: string;
}

function loadUser(ctx: Ctx, where: string, param: unknown): UserRow | undefined {
  return ctx.db.prepare(
    `SELECT u.*, r.code AS role_code, r.name AS role_name, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE ${where}`,
  ).get(param) as UserRow | undefined;
}

export function toSessionUser(u: UserRow): SessionUser {
  let perms: Permission[] | '*';
  try {
    const parsed = JSON.parse(u.permissions);
    perms = parsed === '*' ? '*' : (parsed as string[]).filter((p): p is Permission => (ALL_PERMISSIONS as string[]).includes(p));
  } catch { perms = []; }
  return { id: u.id, username: u.username, fullName: u.full_name, roleCode: u.role_code, roleName: u.role_name, permissions: perms, maxDiscountPct: u.max_discount_pct };
}

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

/** Verify credentials with lockout after repeated failures. */
export function authenticate(ctx: Ctx, username: string, password: string): SessionUser {
  const u = loadUser(ctx, 'u.username = ?', String(username ?? '').trim());
  if (!u) throw new AppError('INVALID_CREDENTIALS');
  const nowIso = ts(ctx);
  if (u.locked_until && u.locked_until > nowIso) throw new AppError('INVALID_CREDENTIALS');
  if (!verifyPassword(String(password ?? ''), u.password_hash)) {
    const attempts = u.failed_attempts + 1;
    const lock = attempts >= MAX_ATTEMPTS ? new Date(ctx.now().getTime() + LOCK_MINUTES * 60_000) : null;
    ctx.db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : attempts, lock ? ts({ ...ctx, now: () => lock }) : null, u.id);
    throw new AppError('INVALID_CREDENTIALS');
  }
  if (!u.active) throw new AppError('USER_INACTIVE');
  ctx.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowIso, u.id);
  return toSessionUser(u);
}

export function login(ctx: Ctx, username: string, password: string): SessionUser {
  const user = authenticate(ctx, username, password);
  audit({ ...ctx, user }, 'auth.login', 'user', user.id);
  return user;
}

export function reloadUser(ctx: Ctx, id: number): SessionUser | null {
  const u = loadUser(ctx, 'u.id = ?', id);
  if (!u || !u.active) return null;
  return toSessionUser(u);
}

export function listLoginUsers(ctx: Ctx) {
  return ctx.db.prepare('SELECT u.username, u.full_name FROM users u WHERE u.active = 1 ORDER BY u.id').all();
}

export function listUsers(ctx: Ctx) {
  requirePerm(ctx, 'users.manage');
  const rows = ctx.db.prepare(
    `SELECT u.id, u.username, u.full_name, u.role_id, u.max_discount_pct, u.active, u.last_login_at, u.created_at, r.name AS role_name, r.code AS role_code
     FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id`,
  ).all();
  return rows;
}

/** Users for filters/reports (no sensitive fields). */
export function listUserNames(ctx: Ctx) {
  return ctx.db.prepare('SELECT id, full_name FROM users ORDER BY id').all();
}

function adminCount(ctx: Ctx, excludeId?: number): number {
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin' AND u.active = 1 AND u.id IS NOT ?`).get(excludeId ?? null) as { n: number }).n;
}

/** Active users vs the limit granted by the license (policy in shared/license-policy). Disabled users do not count. */
export function userQuota(ctx: Ctx) {
  const active = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get() as { n: number }).n;
  const max = ctx.limits?.maxUsers ?? DEFAULT_MAX_USERS;
  return { active, max, canAdd: active < max };
}

function assertUserSlot(ctx: Ctx) {
  const q = userQuota(ctx);
  if (!q.canAdd) throw new AppError('USER_LIMIT', { max: q.max });
}

export function saveUser(ctx: Ctx, id: number | null, raw: unknown) {
  requirePerm(ctx, 'users.manage');
  const input = userInput.parse(raw);
  return tx(ctx, () => {
    const role = ctx.db.prepare('SELECT code FROM roles WHERE id = ?').get(input.roleId) as { code: string } | undefined;
    if (!role) throw new AppError('NOT_FOUND');
    const dup = ctx.db.prepare('SELECT id FROM users WHERE username = ? AND id IS NOT ?').get(input.username, id);
    if (dup) throw new AppError('USERNAME_TAKEN');
    const now = ts(ctx);
    if (id) {
      const cur = loadUser(ctx, 'u.id = ?', id);
      if (!cur) throw new AppError('NOT_FOUND');
      // re-activating a disabled user counts against the licensed user limit
      if (!cur.active && input.active) assertUserSlot(ctx);
      const losingAdmin = cur.role_code === 'admin' && (role.code !== 'admin' || !input.active);
      if (losingAdmin && adminCount(ctx, id) === 0) throw new AppError('LAST_ADMIN');
      ctx.db.prepare('UPDATE users SET username = ?, full_name = ?, role_id = ?, max_discount_pct = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(input.username, input.fullName, input.roleId, input.maxDiscountPct ?? null, input.active ? 1 : 0, now, id);
      if (input.password) ctx.db.prepare('UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?').run(hashPassword(input.password), id);
      audit(ctx, 'user.update', 'user', id, { role: cur.role_code, active: cur.active }, { role: role.code, active: input.active, passwordChanged: !!input.password });
      return { id };
    }
    if (!input.password) throw new AppError('WEAK_PASSWORD');
    if (input.active) assertUserSlot(ctx);
    const info = ctx.db.prepare('INSERT INTO users(username, full_name, password_hash, role_id, max_discount_pct, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.username, input.fullName, hashPassword(input.password), input.roleId, input.maxDiscountPct ?? null, input.active ? 1 : 0, now, now);
    const newId = Number(info.lastInsertRowid);
    audit(ctx, 'user.create', 'user', newId, undefined, { username: input.username, role: role.code });
    return { id: newId };
  });
}

export function changeOwnPassword(ctx: Ctx, current: string, next: string) {
  if (!ctx.user) throw new AppError('NOT_AUTHENTICATED');
  if (!next || next.length < 4) throw new AppError('WEAK_PASSWORD');
  const u = loadUser(ctx, 'u.id = ?', ctx.user.id)!;
  if (!verifyPassword(current, u.password_hash)) throw new AppError('INVALID_CREDENTIALS');
  ctx.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(next), ts(ctx), u.id);
  audit(ctx, 'user.password_change', 'user', u.id);
  return { ok: true };
}

export function listRoles(ctx: Ctx) {
  return ctx.db.prepare('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count FROM roles r ORDER BY r.is_system DESC, r.id').all()
    .map((r: any) => ({ ...r, permissions: JSON.parse(r.permissions) }));
}

export function saveRole(ctx: Ctx, id: number | null, raw: unknown) {
  requirePerm(ctx, 'users.manage');
  const input = roleInput.parse(raw);
  const perms = input.permissions.filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
  if (id) {
    const cur = ctx.db.prepare('SELECT code, permissions FROM roles WHERE id = ?').get(id) as { code: string; permissions: string } | undefined;
    if (!cur) throw new AppError('NOT_FOUND');
    if (cur.code === 'admin') throw new AppError('LAST_ADMIN');
    ctx.db.prepare('UPDATE roles SET name = ?, permissions = ? WHERE id = ?').run(input.name, JSON.stringify(perms), id);
    audit(ctx, 'role.update', 'role', id, JSON.parse(cur.permissions), perms);
    return { id };
  }
  const code = `custom_${Date.now().toString(36)}`;
  const newId = Number(ctx.db.prepare('INSERT INTO roles(code, name, permissions, is_system) VALUES (?, ?, ?, 0)').run(code, input.name, JSON.stringify(perms)).lastInsertRowid);
  audit(ctx, 'role.create', 'role', newId, undefined, perms);
  return { id: newId };
}

export function deleteRole(ctx: Ctx, id: number) {
  requirePerm(ctx, 'users.manage');
  const r = ctx.db.prepare('SELECT is_system FROM roles WHERE id = ?').get(id) as { is_system: number } | undefined;
  if (!r) throw new AppError('NOT_FOUND');
  if (r.is_system || ctx.db.prepare('SELECT 1 FROM users WHERE role_id = ? LIMIT 1').get(id)) throw new AppError('IN_USE');
  ctx.db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  return { ok: true };
}
