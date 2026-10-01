import { openDatabase, migrate } from '../../src/main/db/connection';
import { seedSystemData } from '../../src/main/db/seed';
import type { Ctx } from '../../src/main/services/context';
import { setSettingRaw } from '../../src/main/services/context';
import { completeSetup } from '../../src/main/services/settings';
import { login } from '../../src/main/services/users';
import { createProduct } from '../../src/main/services/products';
import { openShift } from '../../src/main/services/shifts';

export function freshDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  seedSystemData(db);
  return db;
}

export interface TestEnv { ctx: Ctx; clock: { t: Date }; unit: (name: string) => number }

export function setupStore(opts: { shift?: boolean; settings?: Record<string, unknown> } = {}): TestEnv {
  const db = freshDb();
  const clock = { t: new Date(2026, 9, 1, 10, 0, 0) };
  const ctx: Ctx = { db, user: null, now: () => clock.t };
  completeSetup(ctx, {
    storeName: 'سوبر ماركت البركة', phone: '01000000000', address: 'القاهرة', currencyCode: 'EGP', currencySymbol: 'ج.م',
    adminName: 'أحمد', adminUsername: 'admin', adminPassword: '1234', starterCategories: true, mode: 'simple', printType: 'thermal80',
  });
  ctx.user = login(ctx, 'admin', '1234');
  for (const [k, v] of Object.entries(opts.settings ?? {})) setSettingRaw(db, k, v);
  if (opts.shift !== false) openShift(ctx, { openingCash: 50000 });
  const unit = (name: string) => (db.prepare('SELECT id FROM units WHERE name = ?').get(name) as { id: number }).id;
  return { ctx, clock, unit };
}

/** money helper: major -> minor */
export const egp = (v: number) => Math.round(v * 100);

export function addProduct(env: TestEnv, p: { name: string; price: number; cost?: number; unit?: string; qty?: number; barcode?: string; units?: { unit: string; factor: number; price?: number }[]; weighted?: boolean; minStock?: number; trackExpiry?: boolean; expiry?: string }) {
  const baseUnitId = env.unit(p.unit ?? 'قطعة');
  return createProduct(env.ctx, {
    name: p.name, baseUnitId, sellPrice: egp(p.price), cost: p.cost !== undefined ? egp(p.cost) : 0, barcode: p.barcode ?? null,
    isWeighted: !!p.weighted, minStock: (p.minStock ?? 0) * 1000, trackExpiry: !!p.trackExpiry,
    units: (p.units ?? []).map((u) => ({ unitId: env.unit(u.unit), factor: u.factor * 1000, sellPrice: u.price !== undefined ? egp(u.price) : null })),
    openingStock: p.qty ? { qty: p.qty * 1000, unitCost: p.cost !== undefined ? egp(p.cost) : 0, expiryDate: p.expiry ?? null } : null,
  }).id;
}
