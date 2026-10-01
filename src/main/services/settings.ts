import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import { DEFAULT_SETTINGS, type SettingKey, type StoreSettings } from '../../shared/settings';
import { setupInput, type SetupInput } from '../../shared/schemas';
import { STARTER_CATEGORIES } from '../db/seed';
import { type Ctx, audit, getAllSettings, invalidateSettings, requirePerm, setSettingRaw, ts, tx } from './context';
import { hashPassword } from './users';

/** Settings anyone logged in (or the login screen) may read: branding & display only. */
const PUBLIC_KEYS: SettingKey[] = ['store.name', 'store.logo', 'store.phone', 'store.address', 'currency.code', 'currency.symbol', 'ui.digits', 'ui.fontScale', 'onboarding.done'];

export function publicSettings(ctx: Ctx) {
  const all = getAllSettings(ctx.db);
  const out: Partial<StoreSettings> = {};
  for (const k of PUBLIC_KEYS) (out as any)[k] = all[k];
  return out;
}

export function getSettings(ctx: Ctx): StoreSettings {
  if (!ctx.user) throw new AppError('NOT_AUTHENTICATED');
  return getAllSettings(ctx.db);
}

function validate(key: SettingKey, value: unknown): unknown {
  const def = DEFAULT_SETTINGS[key];
  if (typeof def === 'boolean') return !!value;
  if (typeof def === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new AppError('VALIDATION', { detail: key });
    return n;
  }
  const s = String(value ?? '');
  if (key === 'store.logo') {
    if (s && !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(s)) throw new AppError('VALIDATION', { detail: 'صيغة الشعار غير مدعومة' });
    if (s.length > 1_500_000) throw new AppError('VALIDATION', { detail: 'حجم الشعار كبير جدًا (الحد الأقصى 1 ميجا)' });
    return s;
  }
  const enums: Partial<Record<SettingKey, string[]>> = {
    'mode': ['simple', 'advanced'], 'ui.digits': ['latn', 'arab'], 'print.type': ['thermal80', 'thermal58', 'a4'], 'sales.scaleBarcode.mode': ['weight', 'price'],
  };
  if (enums[key] && !enums[key]!.includes(s)) throw new AppError('VALIDATION', { detail: key });
  return s.slice(0, 1000);
}

export function updateSettings(ctx: Ctx, patch: Partial<Record<SettingKey, unknown>>) {
  requirePerm(ctx, 'settings.manage');
  const before = getAllSettings(ctx.db);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  tx(ctx, () => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      const key = k as SettingKey;
      if (key === 'onboarding.done' || key === 'backup.lastAt') continue;
      const value = validate(key, v);
      if (JSON.stringify(before[key]) === JSON.stringify(value)) continue;
      setSettingRaw(ctx.db, key, value);
      changed[key] = { from: key === 'store.logo' ? '[logo]' : before[key], to: key === 'store.logo' ? '[logo]' : value };
    }
    if (patch.mode === 'advanced' && before.mode !== 'advanced') {
      // enabling advanced mode turns on the advanced modules (each can still be toggled individually)
      for (const f of ['features.multiLocation', 'features.expiry', 'features.purchaseOrders', 'features.priceLists', 'features.promotions', 'features.quotations'] as SettingKey[]) {
        if (!(f in patch)) setSettingRaw(ctx.db, f, true);
      }
    }
    if (Object.keys(changed).length) audit(ctx, 'settings.update', 'settings', null, undefined, changed);
  });
  invalidateSettings(ctx.db);
  return getAllSettings(ctx.db);
}

export function setupStatus(ctx: Ctx) {
  const users = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  return { needsSetup: users === 0 };
}

/** First-run onboarding. Allowed only while no user exists. */
export function completeSetup(ctx: Ctx, raw: SetupInput) {
  const input = setupInput.parse(raw);
  return tx(ctx, () => {
    if (!setupStatus(ctx).needsSetup) throw new AppError('ALREADY_SETUP');
    const set = (k: SettingKey, v: unknown) => setSettingRaw(ctx.db, k, v);
    set('store.name', input.storeName);
    set('store.phone', input.phone ?? '');
    set('store.address', input.address ?? '');
    if (input.logo) set('store.logo', validate('store.logo', input.logo));
    set('currency.code', input.currencyCode);
    set('currency.symbol', input.currencySymbol);
    set('mode', input.mode);
    set('print.type', input.printType);
    if (input.mode === 'advanced') {
      for (const f of ['features.multiLocation', 'features.expiry', 'features.purchaseOrders', 'features.priceLists', 'features.promotions', 'features.quotations'] as SettingKey[]) set(f, true);
    }
    ctx.db.prepare('UPDATE stores SET name = ? WHERE id = 1').run(input.storeName);
    // installation/store identity (written into backup metadata; no secrets)
    ctx.db.prepare(`INSERT INTO app_meta(key, value) VALUES ('store_uid', ?) ON CONFLICT(key) DO NOTHING`).run(randomUUID());
    if (input.starterCategories) {
      const ins = ctx.db.prepare('INSERT INTO categories(name, sort_order) VALUES (?, ?) ON CONFLICT(name) DO NOTHING');
      STARTER_CATEGORIES.forEach((c, i) => ins.run(c, i));
    }
    const role = ctx.db.prepare(`SELECT id FROM roles WHERE code = 'admin'`).get() as { id: number };
    const now = ts(ctx);
    const info = ctx.db.prepare('INSERT INTO users(username, full_name, password_hash, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.adminUsername, input.adminName, hashPassword(input.adminPassword), role.id, now, now);
    set('onboarding.done', true);
    invalidateSettings(ctx.db);
    audit({ ...ctx, user: null }, 'setup.complete', 'store', 1, undefined, { storeName: input.storeName, admin: input.adminUsername });
    return { userId: Number(info.lastInsertRowid) };
  });
}

export function listAudit(ctx: Ctx, opts: { from: string; to: string; userId?: number | null; action?: string | null; entity?: string | null; entityId?: number | null; limit?: number; offset?: number }) {
  requirePerm(ctx, 'audit.view');
  const conds = ['substr(a.created_at,1,10) BETWEEN @from AND @to'];
  if (opts.userId) conds.push('a.user_id = @uid');
  if (opts.action) conds.push('a.action LIKE @action');
  if (opts.entity) conds.push('a.entity = @entity');
  if (opts.entityId) conds.push('a.entity_id = @eid');
  return ctx.db.prepare(
    `SELECT a.*, u.full_name AS user_name, ap.full_name AS approved_by_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN users ap ON ap.id = a.approved_by WHERE ${conds.join(' AND ')} ORDER BY a.id DESC LIMIT @limit OFFSET @offset`,
  ).all({ from: opts.from, to: opts.to, uid: opts.userId ?? null, action: opts.action ? `${opts.action}%` : null, entity: opts.entity ?? null, eid: opts.entityId ?? null, limit: Math.min(opts.limit ?? 200, 1000), offset: opts.offset ?? 0 });
}
