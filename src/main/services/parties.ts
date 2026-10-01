import { AppError } from '../../shared/errors';
import { normalizeArabic } from '../../shared/arabic';
import { partyInput, paymentInput, type PartyInput } from '../../shared/schemas';
import { type Ctx, audit, can, docNo, requirePerm, requirePermOrApproval, today, ts, tx } from './context';
import { addCashMovement, expectedCash, shiftForCash } from './shifts';

type Party = 'customer' | 'supplier';
const TABLE: Record<Party, string> = { customer: 'customers', supplier: 'suppliers' };
const LEDGER: Record<Party, string> = { customer: 'customer_ledger', supplier: 'supplier_ledger' };
const FK: Record<Party, string> = { customer: 'customer_id', supplier: 'supplier_id' };

/** Post to a party ledger and update the cached balance. Call inside a transaction. */
export function postLedger(ctx: Ctx, party: Party, partyId: number, type: string, amount: number, ref?: { type: string; id: number } | null, note?: string | null): number {
  if (amount === 0) {
    const r = ctx.db.prepare(`SELECT balance FROM ${TABLE[party]} WHERE id = ?`).get(partyId) as { balance: number } | undefined;
    if (!r) throw new AppError('NOT_FOUND');
    return r.balance;
  }
  const row = ctx.db.prepare(`UPDATE ${TABLE[party]} SET balance = balance + ?, updated_at = ? WHERE id = ? RETURNING balance`).get(amount, ts(ctx), partyId) as { balance: number } | undefined;
  if (!row) throw new AppError('NOT_FOUND');
  ctx.db.prepare(
    `INSERT INTO ${LEDGER[party]}(${FK[party]}, type, amount, balance_after, ref_type, ref_id, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(partyId, type, amount, row.balance, ref?.type ?? null, ref?.id ?? null, note ?? null, ctx.user?.id ?? null, ts(ctx));
  return row.balance;
}

function permFor(party: Party) {
  return party === 'customer' ? 'customers.manage' : 'suppliers.manage';
}

export function saveParty(ctx: Ctx, party: Party, id: number | null, raw: PartyInput) {
  requirePerm(ctx, permFor(party));
  const p = partyInput.parse(raw);
  return tx(ctx, () => {
    const now = ts(ctx);
    if (id) {
      const cur = ctx.db.prepare(`SELECT * FROM ${TABLE[party]} WHERE id = ?`).get(id);
      if (!cur) throw new AppError('NOT_FOUND');
      if (party === 'customer') {
        ctx.db.prepare(`UPDATE customers SET name=?, phone=?, address=?, notes=?, credit_limit=?, price_list_id=?, active=?, updated_at=? WHERE id=?`)
          .run(p.name, p.phone ?? null, p.address ?? null, p.notes ?? null, p.creditLimit ?? null, p.priceListId ?? null, p.active ? 1 : 0, now, id);
      } else {
        ctx.db.prepare(`UPDATE suppliers SET name=?, company=?, phone=?, address=?, notes=?, lead_time_days=?, active=?, updated_at=? WHERE id=?`)
          .run(p.name, p.company ?? null, p.phone ?? null, p.address ?? null, p.notes ?? null, p.leadTimeDays ?? null, p.active ? 1 : 0, now, id);
      }
      audit(ctx, `${party}.update`, party, id, undefined, p);
      return { id };
    }
    let newId: number;
    if (party === 'customer') {
      newId = Number(ctx.db.prepare(`INSERT INTO customers(name, phone, address, notes, credit_limit, price_list_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(p.name, p.phone ?? null, p.address ?? null, p.notes ?? null, p.creditLimit ?? null, p.priceListId ?? null, p.active ? 1 : 0, now, now).lastInsertRowid);
    } else {
      newId = Number(ctx.db.prepare(`INSERT INTO suppliers(name, company, phone, address, notes, lead_time_days, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(p.name, p.company ?? null, p.phone ?? null, p.address ?? null, p.notes ?? null, p.leadTimeDays ?? null, p.active ? 1 : 0, now, now).lastInsertRowid);
    }
    if (p.openingBalance) {
      requirePerm(ctx, 'customers.adjust_balance');
      postLedger(ctx, party, newId, 'opening', p.openingBalance, null, 'رصيد افتتاحي');
    }
    audit(ctx, `${party}.create`, party, newId, undefined, { name: p.name });
    return { id: newId };
  });
}

export function listParties(ctx: Ctx, party: Party, opts: { q?: string; withBalance?: boolean; includeInactive?: boolean; limit?: number } = {}) {
  if (party === 'supplier') requirePerm(ctx, 'purchases.view');
  else if (!can(ctx, 'customers.manage') && !can(ctx, 'pos.sell') && !can(ctx, 'reports.view')) requirePerm(ctx, 'customers.manage');
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  if (!opts.includeInactive) conds.push('t.active = 1');
  if (opts.withBalance) conds.push('t.balance <> 0');
  const q = (opts.q ?? '').trim();
  let rows = ctx.db.prepare(
    `SELECT t.*, (SELECT MAX(created_at) FROM ${LEDGER[party]} l WHERE l.${FK[party]} = t.id) AS last_activity
     FROM ${TABLE[party]} t ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY t.name LIMIT ${Math.min(opts.limit ?? 2000, 5000)}`,
  ).all(params) as Record<string, any>[];
  if (q) {
    const nq = normalizeArabic(q);
    rows = rows.filter((r) => normalizeArabic(`${r.name} ${r.phone ?? ''} ${r.company ?? ''}`).includes(nq));
  }
  return rows;
}

export function getParty(ctx: Ctx, party: Party, id: number): any {
  if (party === 'supplier') requirePerm(ctx, 'purchases.view');
  else if (!can(ctx, 'customers.manage') && !can(ctx, 'pos.sell') && !can(ctx, 'reports.view')) requirePerm(ctx, 'customers.manage');
  const row = ctx.db.prepare(`SELECT * FROM ${TABLE[party]} WHERE id = ?`).get(id) as Record<string, any> | undefined;
  if (!row) throw new AppError('NOT_FOUND');
  const ledger = ctx.db.prepare(
    `SELECT l.*, u.full_name AS user_name,
       CASE l.ref_type WHEN 'sale' THEN (SELECT invoice_no FROM sales WHERE id = l.ref_id)
                       WHEN 'sale_return' THEN (SELECT return_no FROM sale_returns WHERE id = l.ref_id)
                       WHEN 'purchase' THEN (SELECT purchase_no FROM purchases WHERE id = l.ref_id)
                       WHEN 'purchase_return' THEN (SELECT return_no FROM purchase_returns WHERE id = l.ref_id)
                       WHEN 'payment' THEN (SELECT payment_no FROM party_payments WHERE id = l.ref_id) END AS ref_no
     FROM ${LEDGER[party]} l LEFT JOIN users u ON u.id = l.user_id WHERE l.${FK[party]} = ? ORDER BY l.id DESC LIMIT 500`,
  ).all(id);
  const totals = party === 'customer'
    ? ctx.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(credit_amount),0) AS credit FROM sales WHERE customer_id = ? AND status = 'completed'`).get(id)
    : ctx.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(paid),0) AS paid FROM purchases WHERE supplier_id = ?`).get(id);
  const payments = ctx.db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM party_payments WHERE party_type = ? AND party_id = ?`).get(party, id) as { total: number };
  const products = party === 'supplier'
    ? ctx.db.prepare(
      `SELECT p.id, p.name, MAX(pu.purchase_date) AS last_date, COUNT(*) AS times,
              (SELECT pi2.unit_cost FROM purchase_items pi2 JOIN purchases pu2 ON pu2.id = pi2.purchase_id WHERE pi2.product_id = p.id AND pu2.supplier_id = @sid ORDER BY pu2.purchase_date DESC, pi2.id DESC LIMIT 1) AS last_cost,
              (SELECT un.name FROM purchase_items pi2 JOIN purchases pu2 ON pu2.id = pi2.purchase_id JOIN units un ON un.id = pi2.unit_id WHERE pi2.product_id = p.id AND pu2.supplier_id = @sid ORDER BY pu2.purchase_date DESC, pi2.id DESC LIMIT 1) AS last_unit
       FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id JOIN products p ON p.id = pi.product_id
       WHERE pu.supplier_id = @sid GROUP BY p.id ORDER BY last_date DESC LIMIT 300`,
    ).all({ sid: id })
    : [];
  return { ...row, ledger, totals, paymentsTotal: payments.total, products };
}

/** Customer pays (reduces their debt) or store pays supplier (reduces what store owes). */
export function recordPayment(ctx: Ctx, party: Party, raw: unknown) {
  requirePerm(ctx, party === 'customer' ? 'customers.collect' : 'suppliers.pay');
  const p = paymentInput.parse(raw);
  return tx(ctx, () => {
    const row = ctx.db.prepare(`SELECT id, name, balance FROM ${TABLE[party]} WHERE id = ?`).get(p.partyId) as { id: number; name: string; balance: number } | undefined;
    if (!row) throw new AppError('NOT_FOUND');
    let shiftId: number | null = null;
    if (p.method === 'cash' && (party === 'customer' || p.fromDrawer)) {
      const s = shiftForCash(ctx);
      shiftId = s?.id ?? null;
      if (s && party === 'supplier' && expectedCash(ctx, s.id) < p.amount) throw new AppError('CASH_INSUFFICIENT');
    }
    const no = docNo(ctx.db, 'payment', party === 'customer' ? 'RC-' : 'PY-');
    const info = ctx.db.prepare(
      `INSERT INTO party_payments(payment_no, party_type, party_id, amount, method, shift_id, note, user_id, business_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(no, party, p.partyId, p.amount, p.method, shiftId, p.note ?? null, ctx.user?.id ?? null, today(ctx), ts(ctx));
    const payId = Number(info.lastInsertRowid);
    const balance = postLedger(ctx, party, p.partyId, 'payment', -p.amount, { type: 'payment', id: payId }, p.note);
    if (shiftId) addCashMovement(ctx, shiftId, party === 'customer' ? 'customer_payment' : 'supplier_payment', party === 'customer' ? p.amount : -p.amount, { type: 'payment', id: payId }, row.name);
    audit(ctx, `${party}.payment`, party, p.partyId, { balance: row.balance }, { amount: p.amount, balance });
    return { id: payId, paymentNo: no, balance, partyName: row.name, amount: p.amount, method: p.method, createdAt: ts(ctx) };
  });
}

export function adjustBalance(ctx: Ctx, party: Party, input: { partyId: number; amount: number; reason: string }) {
  const approvedBy = requirePermOrApproval(ctx, 'customers.adjust_balance');
  if (!Number.isInteger(input.amount) || input.amount === 0) throw new AppError('AMOUNT_INVALID');
  if (!String(input.reason ?? '').trim()) throw new AppError('VALIDATION', { detail: 'سبب التعديل مطلوب' });
  return tx(ctx, () => {
    const row = ctx.db.prepare(`SELECT balance FROM ${TABLE[party]} WHERE id = ?`).get(input.partyId) as { balance: number } | undefined;
    if (!row) throw new AppError('NOT_FOUND');
    const balance = postLedger(ctx, party, input.partyId, 'adjustment', input.amount, null, input.reason);
    audit(ctx, `${party}.adjust_balance`, party, input.partyId, { balance: row.balance }, { balance }, input.reason, approvedBy);
    return { balance };
  });
}

export function deleteParty(ctx: Ctx, party: Party, id: number) {
  requirePerm(ctx, permFor(party));
  const used = ctx.db.prepare(`SELECT 1 FROM ${LEDGER[party]} WHERE ${FK[party]} = ? LIMIT 1`).get(id)
    || (party === 'customer' ? ctx.db.prepare('SELECT 1 FROM sales WHERE customer_id = @id UNION ALL SELECT 1 FROM held_sales WHERE customer_id = @id UNION ALL SELECT 1 FROM quotations WHERE customer_id = @id LIMIT 1').get({ id }) : ctx.db.prepare('SELECT 1 FROM purchases WHERE supplier_id = ? UNION ALL SELECT 1 FROM purchase_orders WHERE supplier_id = ? LIMIT 1').get(id, id));
  if (used) {
    ctx.db.prepare(`UPDATE ${TABLE[party]} SET active = 0 WHERE id = ?`).run(id);
    audit(ctx, `${party}.deactivate`, party, id);
    return { archived: true };
  }
  if (party === 'supplier') ctx.db.prepare('UPDATE products SET default_supplier_id = NULL WHERE default_supplier_id = ?').run(id);
  ctx.db.prepare(`DELETE FROM ${TABLE[party]} WHERE id = ?`).run(id);
  audit(ctx, `${party}.delete`, party, id);
  return { archived: false };
}
