import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Banknote, Edit, Plus, Printer, Scale, Truck, Users } from 'lucide-react';
import { api, apiApproved } from '../lib/api';
import { useApp } from '../lib/app';
import { dateOnly, dateTime, money } from '../lib/format';
import { Empty, Field, Loading, Modal, MoneyInput, NumberInput, PageHeader, Segmented, Stat, Switch, useAction } from '../components/ui';
import { normalizeArabic } from '../../shared/arabic';

type Kind = 'customer' | 'supplier';
const T = {
  customer: { plural: 'العملاء', single: 'عميل', icon: <Users color="var(--primary)" />, owesLabel: 'عليه', creditLabel: 'له', pay: 'تحصيل دفعة', base: '/customers' },
  supplier: { plural: 'الموردون', single: 'مورد', icon: <Truck color="var(--primary)" />, owesLabel: 'مستحق له', creditLabel: 'رصيد لنا', pay: 'سداد دفعة', base: '/suppliers' },
};

export default function Parties({ kind }: { kind: Kind }) {
  return <Routes><Route index element={<PartyList kind={kind} />} /><Route path=":id" element={<PartyDetail kind={kind} />} /></Routes>;
}

function BalanceCell({ kind, balance }: { kind: Kind; balance: number }) {
  if (balance > 0) return <span className="danger-text bold">{T[kind].owesLabel} {money(balance)}</span>;
  if (balance < 0) return <span className="success-text bold">{T[kind].creditLabel} {money(-balance)}</span>;
  return <span className="muted">—</span>;
}

function PartyList({ kind }: { kind: Kind }) {
  const t = T[kind];
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useApp();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [due, setDue] = useState(!!params.get('due'));
  const [edit, setEdit] = useState<any | null>(null);
  const list = useQuery({ queryKey: [`${kind}s`, due], queryFn: () => api<any[]>(`${kind}s.list`, { withBalance: due, includeInactive: false }) });
  const nq = normalizeArabic(q);
  const rows = (list.data ?? []).filter((r) => !nq || normalizeArabic(`${r.name} ${r.phone ?? ''} ${r.company ?? ''}`).includes(nq));
  const totalDue = (list.data ?? []).filter((r) => r.balance > 0).reduce((a, r) => a + r.balance, 0);
  const canManage = can(kind === 'customer' ? 'customers.manage' : 'suppliers.manage');
  return (
    <div>
      <PageHeader title={t.plural} icon={t.icon} actions={canManage && <button className="btn primary" onClick={() => setEdit({})}><Plus size={16} /> {t.single} جديد</button>} />
      <div className="grid grid-3 mb">
        <Stat label={`عدد ${t.plural}`} value={list.data?.length ?? 0} />
        <Stat tone="primary" label={kind === 'customer' ? 'إجمالي المديونيات (لك عند العملاء)' : 'إجمالي المستحق للموردين (عليك)'} value={<span className="num">{money(totalDue)}</span>} />
        <Stat label={kind === 'customer' ? 'عملاء عليهم مديونية' : 'موردون لهم مستحقات'} value={(list.data ?? []).filter((r) => r.balance > 0).length} />
      </div>
      <div className="card">
        <div className="row" style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
          <input className="input grow" placeholder="بحث بالاسم أو الهاتف" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="check"><Switch checked={due} onChange={setDue} /> {kind === 'customer' ? 'من عليهم فلوس فقط' : 'من لهم مستحقات فقط'}</label>
        </div>
        {list.isLoading ? <Loading /> : !rows.length ? <Empty title={`لا يوجد ${t.plural}`} /> : (
          <table className="table"><thead><tr><th>الاسم</th><th>الهاتف</th>{kind === 'supplier' && <th>الشركة</th>}<th className="n">الرصيد</th><th>آخر حركة</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.id} className="clickable" onClick={() => nav(`${t.base}/${r.id}`)}><td className="bold">{r.name}</td><td className="num">{r.phone ?? '—'}</td>{kind === 'supplier' && <td>{r.company ?? '—'}</td>}<td className="n"><BalanceCell kind={kind} balance={r.balance} /></td><td className="num small">{dateOnly(r.last_activity)}</td></tr>)}</tbody></table>
        )}
      </div>
      {edit && <PartyForm kind={kind} initial={edit} onClose={() => setEdit(null)} onSaved={(id) => { setEdit(null); void qc.invalidateQueries({ queryKey: [`${kind}s`] }); if (!edit.id) nav(`${t.base}/${id}`); }} />}
    </div>
  );
}

function PartyForm({ kind, initial, onClose, onSaved }: { kind: Kind; initial: any; onClose: () => void; onSaved: (id: number) => void }) {
  const { can, feature } = useApp();
  const { run, busy } = useAction();
  const priceLists = useQuery({ queryKey: ['priceLists'], queryFn: () => api<any[]>('priceLists.list'), enabled: feature('priceLists') && kind === 'customer' });
  const [f, setF] = useState({
    name: initial.name ?? '', phone: initial.phone ?? '', address: initial.address ?? '', notes: initial.notes ?? '', company: initial.company ?? '',
    leadTimeDays: initial.lead_time_days ?? null, creditLimit: initial.credit_limit ?? null, priceListId: initial.price_list_id ?? '', openingBalance: null as number | null, active: initial.active ?? 1,
  });
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal title={initial.id ? `تعديل ${initial.name}` : `${T[kind].single} جديد`} onClose={onClose} footer={<button className="btn primary" disabled={busy || !f.name.trim()} onClick={() => run(async () => {
      const r = await api(`${kind}s.save`, { id: initial.id ?? null, data: { name: f.name, phone: f.phone || null, address: f.address || null, notes: f.notes || null, company: f.company || null, leadTimeDays: f.leadTimeDays, creditLimit: f.creditLimit, priceListId: f.priceListId || null, openingBalance: f.openingBalance ?? undefined, active: !!f.active } });
      onSaved(r.id);
    }, 'تم الحفظ')}>حفظ</button>}>
      <div className="form-grid">
        <Field label="الاسم *" className="span-2"><input className="input" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="الهاتف"><input className="input" dir="ltr" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        {kind === 'supplier' && <Field label="الشركة"><input className="input" value={f.company} onChange={(e) => set('company', e.target.value)} /></Field>}
        <Field label="العنوان" className="span-2"><input className="input" value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
        {kind === 'supplier' && <Field label="مدة التوريد (أيام)" help="تُستخدم في اقتراحات الطلب"><NumberInput value={f.leadTimeDays} allowEmpty onChange={(v) => set('leadTimeDays', v)} /></Field>}
        {kind === 'customer' && <Field label="حد الائتمان (أقصى مديونية)" help="اتركه فارغًا بدون حد"><MoneyInput value={f.creditLimit} allowEmpty onChange={(v) => set('creditLimit', v)} /></Field>}
        {kind === 'customer' && feature('priceLists') && <Field label="قائمة الأسعار"><select className="select" value={f.priceListId} onChange={(e) => set('priceListId', Number(e.target.value) || '')}><option value="">سعر القطاعي</option>{(priceLists.data ?? []).filter((p) => !p.is_default).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
        {!initial.id && can('customers.adjust_balance') && <Field label={kind === 'customer' ? 'رصيد سابق عليه' : 'رصيد سابق مستحق له'} help="من قبل استخدام البرنامج"><MoneyInput value={f.openingBalance} allowEmpty onChange={(v) => set('openingBalance', v)} /></Field>}
        <Field label="ملاحظات" className="span-all"><textarea className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        {initial.id && <label className="check"><input type="checkbox" checked={!!f.active} onChange={(e) => set('active', e.target.checked ? 1 : 0)} /> نشط</label>}
      </div>
    </Modal>
  );
}

const LEDGER_TYPES: Record<string, string> = { opening: 'رصيد افتتاحي', sale: 'فاتورة بيع آجل', payment: 'دفعة', return: 'مرتجع', void: 'إلغاء فاتورة', adjustment: 'تعديل رصيد', purchase: 'فاتورة شراء' };

function PartyDetail({ kind }: { kind: Kind }) {
  const t = T[kind];
  const { id } = useParams();
  const pid = Number(id);
  const { can } = useApp();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<null | 'pay' | 'adjust' | 'edit'>(null);
  const p = useQuery({ queryKey: [kind, pid], queryFn: () => api(`${kind}s.get`, { id: pid }) });
  if (p.isLoading) return <Loading />;
  const d = p.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: [kind, pid] }); void qc.invalidateQueries({ queryKey: [`${kind}s`] }); };
  const canPay = can(kind === 'customer' ? 'customers.collect' : 'suppliers.pay');
  return (
    <div>
      <PageHeader title={<>{d.name} {!d.active && <span className="badge">موقوف</span>}</>} sub={[d.phone, d.company, d.address].filter(Boolean).join(' • ')} icon={t.icon}
        actions={<>
          <Link to={t.base} className="btn">رجوع</Link>
          <button className="btn" onClick={() => void api('print.doc', { title: `كشف حساب ${d.name}`, rows: [['الرصيد الحالي', money(d.balance)], ...d.ledger.slice(0, 40).map((l: any) => [`${dateOnly(l.created_at)} ${LEDGER_TYPES[l.type]} ${l.ref_no ?? ''}`, money(l.amount)])] })}><Printer size={16} /> طباعة كشف حساب</button>
          {can('customers.adjust_balance') && <button className="btn" onClick={() => setDialog('adjust')}><Scale size={16} /> تعديل رصيد</button>}
          {can(kind === 'customer' ? 'customers.manage' : 'suppliers.manage') && <button className="btn" onClick={() => setDialog('edit')}><Edit size={16} /> تعديل</button>}
          {canPay && <button className="btn primary" onClick={() => setDialog('pay')}><Banknote size={16} /> {t.pay}</button>}
        </>} />
      <div className="grid grid-4 mb">
        <div className={`card stat ${d.balance > 0 ? 'primary' : ''}`}><div className="label">الرصيد الحالي</div><div className="value num">{money(Math.abs(d.balance))}</div><div className="hint">{d.balance > 0 ? t.owesLabel : d.balance < 0 ? t.creditLabel : 'لا يوجد رصيد'}</div></div>
        <Stat label={kind === 'customer' ? 'إجمالي المشتريات منا' : 'إجمالي المشتريات منه'} value={<span className="num">{money(d.totals.total)}</span>} hint={`${d.totals.count} فاتورة`} />
        <Stat label="إجمالي الدفعات" value={<span className="num">{money(d.paymentsTotal)}</span>} />
        {kind === 'customer' ? <Stat label="حد الائتمان" value={d.credit_limit === null ? 'بدون حد' : <span className="num">{money(d.credit_limit)}</span>} /> : <Stat label="مدة التوريد" value={d.lead_time_days ? `${d.lead_time_days} يوم` : '—'} />}
      </div>
      <div className="grid" style={{ gridTemplateColumns: kind === 'supplier' ? '1.4fr 1fr' : '1fr' }}>
        <div className="card">
          <div className="card-head"><h3>كشف الحساب</h3></div>
          {!d.ledger.length ? <Empty title="لا توجد حركات" /> : (
            <div className="table-wrap" style={{ maxHeight: 520 }}><table className="table"><thead><tr><th>التاريخ</th><th>البيان</th><th>المرجع</th><th className="n">مدين / دائن</th><th className="n">الرصيد بعدها</th><th>ملاحظة</th></tr></thead>
              <tbody>{d.ledger.map((l: any) => <tr key={l.id}><td className="num small">{dateTime(l.created_at)}</td><td>{LEDGER_TYPES[l.type] ?? l.type}</td><td className="num small">{l.ref_no ?? '—'}</td><td className={`n bold ${l.amount > 0 ? 'danger-text' : 'success-text'}`}>{l.amount > 0 ? '+' : ''}{money(l.amount)}</td><td className="n">{money(l.balance_after)}</td><td className="small muted">{l.note ?? ''}</td></tr>)}</tbody></table></div>
          )}
        </div>
        {kind === 'supplier' && (
          <div className="card">
            <div className="card-head"><h3>المنتجات وآخر أسعار الشراء</h3></div>
            {!d.products.length ? <Empty title="لم يتم الشراء منه بعد" /> : (
              <table className="table"><thead><tr><th>المنتج</th><th className="n">آخر سعر</th><th>آخر شراء</th></tr></thead>
                <tbody>{d.products.map((x: any) => <tr key={x.id}><td><Link to={`/products/${x.id}`}>{x.name}</Link></td><td className="n">{money(x.last_cost)} <span className="xs muted">/{x.last_unit}</span></td><td className="num small">{dateOnly(x.last_date)}</td></tr>)}</tbody></table>
            )}
          </div>
        )}
      </div>
      {dialog === 'pay' && <PaymentDialog kind={kind} party={d} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog === 'adjust' && <AdjustBalanceDialog kind={kind} party={d} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog === 'edit' && <PartyForm kind={kind} initial={d} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refresh(); }} />}
    </div>
  );
}

function PaymentDialog({ kind, party, onClose }: { kind: Kind; party: any; onClose: () => void }) {
  const [amount, setAmount] = useState<number | null>(party.balance > 0 ? party.balance : null);
  const [method, setMethod] = useState<'cash' | 'card' | 'wallet' | 'bank'>('cash');
  const [fromDrawer, setFromDrawer] = useState(true);
  const [note, setNote] = useState('');
  const [printIt, setPrintIt] = useState(false);
  const { run, busy } = useAction();
  const qc = useQueryClient();
  return (
    <Modal title={`${T[kind].pay} — ${party.name}`} size="sm" onClose={onClose} footer={<button className="btn primary" disabled={busy || !amount} onClick={() => run(async () => {
      const r = await api(`${kind}s.pay`, { partyId: party.id, amount, method, fromDrawer, note: note || null });
      await qc.invalidateQueries({ queryKey: ['shift'] });
      if (printIt) void api('print.doc', { title: kind === 'customer' ? 'إيصال استلام نقدية' : 'إيصال سداد', rows: [['رقم الإيصال', r.paymentNo], [kind === 'customer' ? 'العميل' : 'المورد', r.partyName], ['المبلغ', money(r.amount)], ['الرصيد بعد الدفعة', money(r.balance)], ['التاريخ', dateTime(r.createdAt)]] }).catch(() => {});
      onClose();
    }, 'تم تسجيل الدفعة')}>تسجيل الدفعة</button>}>
      <div className="col">
        <div className="alert info">الرصيد الحالي: <b>{money(party.balance)}</b></div>
        <Field label="المبلغ"><MoneyInput className="lg" autoFocus value={amount} allowEmpty onChange={setAmount} /></Field>
        <Segmented value={method} onChange={setMethod} options={[{ value: 'cash', label: 'نقدي' }, { value: 'bank', label: 'تحويل' }, { value: 'card', label: 'كارت' }, { value: 'wallet', label: 'محفظة' }]} />
        {kind === 'supplier' && method === 'cash' && <label className="check"><input type="checkbox" checked={fromDrawer} onChange={(e) => setFromDrawer(e.target.checked)} /> صرف من درج الكاشير الحالي</label>}
        <Field label="ملاحظة"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={printIt} onChange={(e) => setPrintIt(e.target.checked)} /> طباعة إيصال</label>
      </div>
    </Modal>
  );
}

function AdjustBalanceDialog({ kind, party, onClose }: { kind: Kind; party: any; onClose: () => void }) {
  const [dir, setDir] = useState<'up' | 'down'>('down');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const { run, busy } = useAction();
  return (
    <Modal title="تعديل الرصيد" size="sm" onClose={onClose} footer={<button className="btn primary" disabled={busy || !amount || !reason.trim()} onClick={() => run(async () => { await apiApproved(`${kind}s.adjust`, { partyId: party.id, amount: dir === 'up' ? amount : -(amount ?? 0), reason }); onClose(); }, 'تم تعديل الرصيد وتسجيله في السجل')}>حفظ</button>}>
      <div className="col">
        <div className="alert warning small">تعديل الرصيد عملية حساسة وتُسجل في سجل العمليات. استخدم "{T[kind].pay}" للدفعات العادية.</div>
        <Segmented value={dir} onChange={setDir} options={[{ value: 'up', label: kind === 'customer' ? 'زيادة المديونية' : 'زيادة المستحق' }, { value: 'down', label: 'تخفيض' }]} />
        <Field label="المبلغ"><MoneyInput value={amount} allowEmpty onChange={setAmount} /></Field>
        <Field label="السبب (مطلوب)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
