import type { DB } from './connection';
import { SYSTEM_ROLES } from '../../shared/permissions';
import { localTimestamp } from '../services/context';

/** System data required by the engine. Contains NO demo/fake business data. */
export const SYSTEM_UNITS: { name: string; symbol: string; kind: 'count' | 'weight' | 'volume'; allowDecimal: boolean }[] = [
  { name: 'قطعة', symbol: 'قطعة', kind: 'count', allowDecimal: false },
  { name: 'علبة', symbol: 'علبة', kind: 'count', allowDecimal: false },
  { name: 'كرتونة', symbol: 'كرتونة', kind: 'count', allowDecimal: false },
  { name: 'صندوق', symbol: 'صندوق', kind: 'count', allowDecimal: false },
  { name: 'كيس', symbol: 'كيس', kind: 'count', allowDecimal: false },
  { name: 'زجاجة', symbol: 'زجاجة', kind: 'count', allowDecimal: false },
  { name: 'عبوة', symbol: 'عبوة', kind: 'count', allowDecimal: false },
  { name: 'دستة', symbol: 'دستة', kind: 'count', allowDecimal: false },
  { name: 'كيلو', symbol: 'كجم', kind: 'weight', allowDecimal: true },
  { name: 'جرام', symbol: 'جم', kind: 'weight', allowDecimal: true },
  { name: 'لتر', symbol: 'لتر', kind: 'volume', allowDecimal: true },
  { name: 'ملليلتر', symbol: 'مل', kind: 'volume', allowDecimal: true },
];

export const DEFAULT_EXPENSE_CATEGORIES = ['كهرباء', 'إيجار', 'رواتب', 'نقل ومواصلات', 'صيانة', 'مياه وغاز', 'إنترنت وتليفون', 'مصروفات تشغيل', 'أخرى'];

/** Optional starter categories offered (not forced) during onboarding. */
export const STARTER_CATEGORIES = ['مشروبات', 'شيبسي وسناكس', 'حلويات وشوكولاتة', 'ألبان وأجبان', 'مجمدات', 'معلبات', 'منظفات', 'منتجات بالوزن', 'بقالة جافة', 'عناية شخصية'];

export function seedSystemData(db: DB): void {
  const now = localTimestamp(new Date());
  const has = (sql: string) => !!db.prepare(sql).get();
  db.transaction(() => {
    if (!has('SELECT 1 FROM stores LIMIT 1')) {
      db.prepare(`INSERT INTO stores(id, name, code, is_default, created_at) VALUES (1, 'المحل الرئيسي', 'MAIN', 1, ?)`).run(now);
    }
    if (!has('SELECT 1 FROM locations LIMIT 1')) {
      db.prepare(`INSERT INTO locations(store_id, name, type, is_default, created_at) VALUES (1, 'المحل', 'shop', 1, ?)`).run(now);
    }
    const insRole = db.prepare('INSERT INTO roles(code, name, permissions, is_system) VALUES (?, ?, ?, 1) ON CONFLICT(code) DO UPDATE SET permissions = CASE WHEN roles.code = \'admin\' THEN excluded.permissions ELSE roles.permissions END');
    for (const r of SYSTEM_ROLES) {
      insRole.run(r.code, r.name, JSON.stringify(r.permissions === '*' ? '*' : r.permissions));
    }
    // one-time permission upgrades for existing system roles (new features added in later schema versions)
    const upgraded = db.prepare(`SELECT 1 FROM app_meta WHERE key = 'perm_upgrade_v2'`).get();
    if (!upgraded) {
      const mgr = db.prepare(`SELECT permissions FROM roles WHERE code = 'manager'`).get() as { permissions: string } | undefined;
      if (mgr) {
        const perms = new Set<string>(JSON.parse(mgr.permissions));
        perms.add('promotions.approve');
        perms.add('promotions.override');
        db.prepare(`UPDATE roles SET permissions = ? WHERE code = 'manager'`).run(JSON.stringify([...perms]));
      }
      db.prepare(`INSERT INTO app_meta(key, value) VALUES ('perm_upgrade_v2', '1') ON CONFLICT(key) DO NOTHING`).run();
    }
    const insUnit = db.prepare('INSERT INTO units(name, symbol, kind, allow_decimal, is_system) VALUES (?, ?, ?, ?, 1) ON CONFLICT(name) DO NOTHING');
    for (const u of SYSTEM_UNITS) insUnit.run(u.name, u.symbol, u.kind, u.allowDecimal ? 1 : 0);
    db.prepare(`INSERT INTO price_lists(code, name, is_default) VALUES ('retail', 'سعر القطاعي', 1) ON CONFLICT(code) DO NOTHING`).run();
    db.prepare(`INSERT INTO price_lists(code, name, is_default) VALUES ('wholesale', 'سعر الجملة', 0) ON CONFLICT(code) DO NOTHING`).run();
    const insExp = db.prepare('INSERT INTO expense_categories(name) VALUES (?) ON CONFLICT(name) DO NOTHING');
    if (!has('SELECT 1 FROM expense_categories LIMIT 1')) for (const c of DEFAULT_EXPENSE_CATEGORIES) insExp.run(c);
  })();
}
