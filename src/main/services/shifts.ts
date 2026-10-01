import { AppError } from '../../shared/errors';
import { type Ctx, audit, can, getSetting, requirePerm, requireUser, ts, tx } from './context';

export interface ShiftRow {
  id: number; user_id: number; terminal: string; status: 'open' | 'closed'; opening_cash: number; expected_cash: number | null;
  counted_cash: number | null; variance: number | null; opened_at: string; closed_at: string | null; closed_by: number | null; close_note: string | null;
}

export const CASH_LABELS: Record<string, string> = {
  opening: 'رصيد افتتاحي', sale: 'مبيعات نقدية', refund: 'مرتجعات نقدية', expense: 'مصروفات', withdrawal: 'سحب نقدية',
  deposit: 'إضافة نقدية', customer_payment: 'تحصيل من عملاء', supplier_payment: 'سداد موردين', void: 'إلغاء فواتير', purchase: 'مشتريات نقدية',
};

export function currentShift(ctx: Ctx, userId?: number): ShiftRow | null {
  const uid = userId ?? ctx.user?.id;
  if (!uid) return null;
  return (ctx.db.prepare(`SELECT * FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`).get(uid) as ShiftRow | undefined) ?? null;
}

/**
 * Returns the open shift for cash operations. When shifts are mandatory and
 * none is open, throws SHIFT_REQUIRED. When optional, returns null.
 */
export function shiftForCash(ctx: Ctx, opts: { mandatory?: boolean } = {}): ShiftRow | null {
  const s = currentShift(ctx);
  if (s) return s;
  if (opts.mandatory || getSetting(ctx.db, 'sales.requireShift')) throw new AppError('SHIFT_REQUIRED');
  return null;
}

export function addCashMovement(ctx: Ctx, shiftId: number, type: string, amount: number, ref?: { type: string; id: number } | null, note?: string | null) {
  if (amount === 0) return;
  ctx.db.prepare(
    `INSERT INTO cash_movements(shift_id, type, amount, ref_type, ref_id, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(shiftId, type, amount, ref?.type ?? null, ref?.id ?? null, note ?? null, ctx.user?.id ?? null, ts(ctx));
}

export function expectedCash(ctx: Ctx, shiftId: number): number {
  const s = ctx.db.prepare('SELECT opening_cash FROM shifts WHERE id = ?').get(shiftId) as { opening_cash: number } | undefined;
  if (!s) throw new AppError('NOT_FOUND');
  const m = ctx.db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM cash_movements WHERE shift_id = ?').get(shiftId) as { t: number };
  return s.opening_cash + m.t;
}

export function openShift(ctx: Ctx, input: { openingCash: number; terminal?: string | null }) {
  const user = requireUser(ctx);
  requirePerm(ctx, 'pos.sell');
  if (!Number.isInteger(input.openingCash) || input.openingCash < 0) throw new AppError('AMOUNT_INVALID');
  return tx(ctx, () => {
    if (currentShift(ctx)) throw new AppError('SHIFT_ALREADY_OPEN');
    const info = ctx.db.prepare(`INSERT INTO shifts(user_id, terminal, opening_cash, opened_at) VALUES (?, ?, ?, ?)`).run(user.id, (input.terminal || ctx.terminal || 'الكاشير 1').slice(0, 50), input.openingCash, ts(ctx));
    const id = Number(info.lastInsertRowid);
    audit(ctx, 'shift.open', 'shift', id, undefined, { openingCash: input.openingCash });
    return getShiftSummary(ctx, id);
  });
}

export function cashInOut(ctx: Ctx, input: { type: 'withdrawal' | 'deposit'; amount: number; note?: string | null }) {
  requirePerm(ctx, 'cash.manage');
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new AppError('AMOUNT_INVALID');
  return tx(ctx, () => {
    const s = shiftForCash(ctx, { mandatory: true })!;
    if (input.type === 'withdrawal' && expectedCash(ctx, s.id) < input.amount) throw new AppError('CASH_INSUFFICIENT');
    addCashMovement(ctx, s.id, input.type, input.type === 'withdrawal' ? -input.amount : input.amount, null, input.note);
    audit(ctx, `cash.${input.type}`, 'shift', s.id, undefined, { amount: input.amount }, input.note);
    return getShiftSummary(ctx, s.id);
  });
}

export function getShiftSummary(ctx: Ctx, id: number) {
  const s = ctx.db.prepare(
    `SELECT s.*, u.full_name AS user_name, cb.full_name AS closed_by_name FROM shifts s JOIN users u ON u.id = s.user_id
     LEFT JOIN users cb ON cb.id = s.closed_by WHERE s.id = ?`,
  ).get(id) as (ShiftRow & { user_name: string; closed_by_name: string | null }) | undefined;
  if (!s) throw new AppError('NOT_FOUND');
  if (ctx.user && s.user_id !== ctx.user.id && !can(ctx, 'shifts.view_all')) throw new AppError('FORBIDDEN');
  const cash = ctx.db.prepare('SELECT type, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS count FROM cash_movements WHERE shift_id = ? GROUP BY type').all(id) as { type: string; amount: number; count: number }[];
  const sales = ctx.db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(line_discount + invoice_discount),0) AS discounts
     FROM sales WHERE shift_id = ? AND status = 'completed'`,
  ).get(id) as { count: number; total: number; discounts: number };
  const voided = ctx.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM sales WHERE shift_id = ? AND status = 'voided'`).get(id) as { count: number; total: number };
  const byMethod = ctx.db.prepare(
    `SELECT sp.method, COALESCE(SUM(sp.amount),0) AS amount FROM sale_payments sp JOIN sales sa ON sa.id = sp.sale_id
     WHERE sa.shift_id = ? AND sa.status = 'completed' GROUP BY sp.method`,
  ).all(id) as { method: string; amount: number }[];
  const returns = ctx.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM sale_returns WHERE shift_id = ?`).get(id) as { count: number; total: number };
  const expected = s.status === 'open' ? expectedCash(ctx, id) : s.expected_cash ?? expectedCash(ctx, id);
  const hoursOpen = (Date.parse(s.closed_at ?? ts(ctx)) - Date.parse(s.opened_at)) / 3_600_000;
  return { ...s, expected, cash, sales, voided, byMethod, returns, hoursOpen: Math.round(hoursOpen * 10) / 10 };
}

export function closeShift(ctx: Ctx, input: { shiftId?: number | null; countedCash: number; note?: string | null }) {
  const user = requireUser(ctx);
  if (!Number.isInteger(input.countedCash) || input.countedCash < 0) throw new AppError('AMOUNT_INVALID');
  return tx(ctx, () => {
    const s = input.shiftId
      ? (ctx.db.prepare('SELECT * FROM shifts WHERE id = ?').get(input.shiftId) as ShiftRow | undefined)
      : currentShift(ctx) ?? undefined;
    if (!s) throw new AppError('SHIFT_NOT_OPEN');
    if (s.status !== 'open') throw new AppError('SHIFT_CLOSED');
    if (s.user_id !== user.id) requirePerm(ctx, 'shifts.close_others');
    const expected = expectedCash(ctx, s.id);
    const variance = input.countedCash - expected;
    ctx.db.prepare(
      `UPDATE shifts SET status = 'closed', expected_cash = ?, counted_cash = ?, variance = ?, closed_at = ?, closed_by = ?, close_note = ? WHERE id = ?`,
    ).run(expected, input.countedCash, variance, ts(ctx), user.id, input.note ?? null, s.id);
    // held sales belong to the cashier, not the shift: keep them.
    audit(ctx, 'shift.close', 'shift', s.id, { expected }, { counted: input.countedCash, variance }, input.note);
    return getShiftSummary(ctx, s.id);
  });
}

export function listShifts(ctx: Ctx, opts: { from?: string; to?: string; userId?: number | null; status?: string | null } = {}) {
  const user = requireUser(ctx);
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  if (!can(ctx, 'shifts.view_all')) { conds.push('s.user_id = @me'); params.me = user.id; }
  else if (opts.userId) { conds.push('s.user_id = @uid'); params.uid = opts.userId; }
  if (opts.from) { conds.push('substr(s.opened_at,1,10) >= @from'); params.from = opts.from; }
  if (opts.to) { conds.push('substr(s.opened_at,1,10) <= @to'); params.to = opts.to; }
  if (opts.status) { conds.push('s.status = @st'); params.st = opts.status; }
  return ctx.db.prepare(
    `SELECT s.*, u.full_name AS user_name,
            (SELECT COUNT(*) FROM sales sa WHERE sa.shift_id = s.id AND sa.status = 'completed') AS sales_count,
            (SELECT COALESCE(SUM(total),0) FROM sales sa WHERE sa.shift_id = s.id AND sa.status = 'completed') AS sales_total
     FROM shifts s JOIN users u ON u.id = s.user_id ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
     ORDER BY s.id DESC LIMIT 300`,
  ).all(params);
}

export function openShifts(ctx: Ctx) {
  return ctx.db.prepare(`SELECT s.id, s.user_id, s.opened_at, s.terminal, u.full_name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.status = 'open'`).all() as { id: number; user_id: number; opened_at: string; terminal: string; user_name: string }[];
}

export function shiftMovements(ctx: Ctx, shiftId: number) {
  getShiftSummary(ctx, shiftId); // permission check
  return ctx.db.prepare(
    `SELECT c.*, u.full_name AS user_name FROM cash_movements c LEFT JOIN users u ON u.id = c.user_id WHERE c.shift_id = ? ORDER BY c.id DESC`,
  ).all(shiftId);
}
