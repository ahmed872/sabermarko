import { AppError } from '../../shared/errors';
import { expenseInput } from '../../shared/schemas';
import { type Ctx, audit, requirePerm, today, ts, tx } from './context';
import { addCashMovement, expectedCash, shiftForCash } from './shifts';

export function listExpenseCategories(ctx: Ctx) {
  return ctx.db.prepare('SELECT * FROM expense_categories WHERE active = 1 ORDER BY id').all();
}

export function saveExpenseCategory(ctx: Ctx, input: { id?: number; name: string; active?: boolean }) {
  requirePerm(ctx, 'expenses.manage');
  const name = String(input.name ?? '').trim();
  if (!name) throw new AppError('VALIDATION', { detail: 'الاسم مطلوب' });
  try {
    if (input.id) {
      ctx.db.prepare('UPDATE expense_categories SET name = ?, active = ? WHERE id = ?').run(name, input.active === false ? 0 : 1, input.id);
      return { id: input.id };
    }
    return { id: Number(ctx.db.prepare('INSERT INTO expense_categories(name) VALUES (?)').run(name).lastInsertRowid) };
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new AppError('DUPLICATE_NAME', { name });
    throw e;
  }
}

export function createExpense(ctx: Ctx, raw: unknown) {
  requirePerm(ctx, 'expenses.manage');
  const input = expenseInput.parse(raw);
  return tx(ctx, () => {
    let shiftId: number | null = null;
    if (input.paidFromDrawer) {
      const s = shiftForCash(ctx, { mandatory: true })!;
      if (expectedCash(ctx, s.id) < input.amount) throw new AppError('CASH_INSUFFICIENT');
      shiftId = s.id;
    }
    const cat = ctx.db.prepare('SELECT name FROM expense_categories WHERE id = ?').get(input.categoryId) as { name: string } | undefined;
    if (!cat) throw new AppError('NOT_FOUND');
    const info = ctx.db.prepare(
      `INSERT INTO expenses(category_id, amount, note, paid_from_drawer, shift_id, user_id, business_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.categoryId, input.amount, input.note ?? null, shiftId ? 1 : 0, shiftId, ctx.user?.id ?? null, input.businessDate ?? today(ctx), ts(ctx));
    const id = Number(info.lastInsertRowid);
    if (shiftId) addCashMovement(ctx, shiftId, 'expense', -input.amount, { type: 'expense', id }, `${cat.name}${input.note ? ' - ' + input.note : ''}`);
    audit(ctx, 'expense.create', 'expense', id, undefined, { amount: input.amount, category: cat.name });
    return { id };
  });
}

/** Soft delete; if the expense was paid from an open drawer the cash is returned to it. */
export function deleteExpense(ctx: Ctx, id: number, reason: string) {
  requirePerm(ctx, 'expenses.manage');
  return tx(ctx, () => {
    const e = ctx.db.prepare('SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, any> | undefined;
    if (!e) throw new AppError('NOT_FOUND');
    if (e.paid_from_drawer && e.shift_id) {
      const s = ctx.db.prepare(`SELECT status FROM shifts WHERE id = ?`).get(e.shift_id) as { status: string };
      if (s.status === 'open') addCashMovement(ctx, e.shift_id, 'expense', e.amount, { type: 'expense', id }, 'إلغاء مصروف');
      else {
        const cur = shiftForCash(ctx);
        if (cur) addCashMovement(ctx, cur.id, 'deposit', e.amount, { type: 'expense', id }, 'إلغاء مصروف من وردية سابقة');
      }
    }
    ctx.db.prepare('UPDATE expenses SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(ts(ctx), ctx.user?.id ?? null, id);
    audit(ctx, 'expense.delete', 'expense', id, { amount: e.amount }, undefined, reason);
    return { ok: true };
  });
}

export function listExpenses(ctx: Ctx, opts: { from: string; to: string; categoryId?: number | null }) {
  requirePerm(ctx, 'expenses.manage');
  const rows = ctx.db.prepare(
    `SELECT e.*, c.name AS category_name, u.full_name AS user_name FROM expenses e JOIN expense_categories c ON c.id = e.category_id
     LEFT JOIN users u ON u.id = e.user_id WHERE e.deleted_at IS NULL AND e.business_date BETWEEN @from AND @to ${opts.categoryId ? 'AND e.category_id = @cat' : ''}
     ORDER BY e.business_date DESC, e.id DESC LIMIT 2000`,
  ).all({ from: opts.from, to: opts.to, cat: opts.categoryId ?? null });
  const byCategory = ctx.db.prepare(
    `SELECT c.name, SUM(e.amount) AS total, COUNT(*) AS count FROM expenses e JOIN expense_categories c ON c.id = e.category_id
     WHERE e.deleted_at IS NULL AND e.business_date BETWEEN ? AND ? GROUP BY c.id ORDER BY total DESC`,
  ).all(opts.from, opts.to);
  return { rows, byCategory };
}
