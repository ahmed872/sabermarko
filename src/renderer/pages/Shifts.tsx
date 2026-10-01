import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownCircle, ArrowUpCircle, Lock, Printer, Timer } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { METHOD_LABEL, dateTime, money } from '../lib/format';
import { DateRangePicker, Empty, Field, Loading, Modal, MoneyInput, PageHeader, Segmented, Stat, presetRange, useAction, type Range } from '../components/ui';

const CASH_LABELS: Record<string, string> = {
  sale: 'مبيعات نقدية', refund: 'مرتجعات نقدية', expense: 'مصروفات', withdrawal: 'سحب نقدية', deposit: 'إضافة نقدية',
  customer_payment: 'تحصيل من عملاء', supplier_payment: 'سداد موردين', void: 'إلغاء فواتير', purchase: 'مشتريات نقدية',
};

export function shiftReportRows(s: any): [string, string][] {
  return [
    ['الكاشير', s.user_name], ['الفتح', dateTime(s.opened_at)], ['الإغلاق', s.closed_at ? dateTime(s.closed_at) : 'مفتوحة'],
    ['عدد الفواتير', String(s.sales.count)], ['إجمالي المبيعات', money(s.sales.total)], ['الخصومات', money(s.sales.discounts)],
    ...s.byMethod.map((m: any) => [`  ${METHOD_LABEL[m.method]}`, money(m.amount)] as [string, string]),
    ['المرتجعات', `${s.returns.count} — ${money(s.returns.total)}`], ['الفواتير الملغاة', `${s.voided.count} — ${money(s.voided.total)}`],
    ['رصيد افتتاحي', money(s.opening_cash)],
    ...s.cash.map((c: any) => [CASH_LABELS[c.type] ?? c.type, money(c.amount)] as [string, string]),
    ['النقدية المتوقعة', money(s.expected)],
    ...(s.counted_cash !== null ? [['النقدية الفعلية', money(s.counted_cash)] as [string, string], ['الفرق', money(s.variance)] as [string, string]] : []),
  ];
}

export default function Shifts() {
  const { can } = useApp();
  const qc = useQueryClient();
  const [range, setRange] = useState<Range>(presetRange('week'));
  const [dialog, setDialog] = useState<null | { kind: 'cash' | 'close' | 'view'; shift?: any }>(null);
  const current = useQuery({ queryKey: ['shift'], queryFn: () => api('shifts.current') });
  const list = useQuery({ queryKey: ['shifts', range], queryFn: () => api<any[]>('shifts.list', range) });
  const s = current.data;
  return (
    <div>
      <PageHeader title="الورديات والخزنة" icon={<Timer color="var(--primary)" />} />
      {current.isLoading ? <Loading /> : s ? (
        <div className="card pad mb">
          <div className="row mb"><h2>ورديتك الحالية</h2><span className="badge success">مفتوحة منذ {dateTime(s.opened_at)}</span><div className="grow" />
            {can('cash.manage') && <button className="btn" onClick={() => setDialog({ kind: 'cash' })}><ArrowDownCircle size={16} /> سحب / إضافة نقدية</button>}
            <button className="btn" onClick={() => void api('print.doc', { title: 'تقرير وردية (X)', rows: shiftReportRows(s) })}><Printer size={16} /> طباعة تقرير</button>
            <button className="btn primary" onClick={() => setDialog({ kind: 'close', shift: s })}><Lock size={16} /> إغلاق الوردية</button>
          </div>
          <div className="grid grid-4">
            <Stat label="النقدية المتوقعة في الدرج" tone="primary" value={<span className="num">{money(s.expected)}</span>} hint={`افتتاحي ${money(s.opening_cash)}`} />
            <Stat label="المبيعات" value={<span className="num">{money(s.sales.total)}</span>} hint={`${s.sales.count} فاتورة`} />
            <Stat label="طرق الدفع" value={<span className="small">{s.byMethod.map((m: any) => `${METHOD_LABEL[m.method]} ${money(m.amount)}`).join(' • ') || '—'}</span>} />
            <Stat label="المرتجعات / الإلغاء" value={<span className="num">{money(s.returns.total)}</span>} hint={`${s.returns.count} مرتجع • ${s.voided.count} ملغاة`} />
          </div>
          {s.cash.length > 0 && <div className="row wrap small mt" style={{ gap: 18 }}>{s.cash.map((c: any) => <span key={c.type}>{CASH_LABELS[c.type]}: <b className={c.amount < 0 ? 'danger-text' : 'success-text'}>{money(c.amount)}</b></span>)}</div>}
          {s.hoursOpen > 14 && <div className="alert warning mt">الوردية مفتوحة منذ {s.hoursOpen} ساعة — يُنصح بإغلاقها ومطابقة الدرج.</div>}
        </div>
      ) : <div className="alert info mb">لا توجد لديك وردية مفتوحة. ستُفتح الوردية عند الدخول لشاشة البيع.</div>}
      <div className="row mb"><DateRangePicker value={range} onChange={setRange} /></div>
      <div className="card">
        {!list.data?.length ? <Empty title="لا توجد ورديات في هذه الفترة" /> : (
          <table className="table"><thead><tr><th>الكاشير</th><th>الجهاز</th><th>الفتح</th><th>الإغلاق</th><th className="n">الفواتير</th><th className="n">المبيعات</th><th className="n">المتوقع</th><th className="n">الفعلي</th><th className="n">الفرق</th><th /></tr></thead>
            <tbody>{list.data.map((x) => (
              <tr key={x.id} className="clickable" onClick={() => void api('shifts.summary', { id: x.id }).then((d) => setDialog({ kind: 'view', shift: d }))}>
                <td className="bold">{x.user_name}</td><td className="small">{x.terminal}</td><td className="num small">{dateTime(x.opened_at)}</td><td className="num small">{x.closed_at ? dateTime(x.closed_at) : <span className="badge success">مفتوحة</span>}</td>
                <td className="n">{x.sales_count}</td><td className="n">{money(x.sales_total)}</td><td className="n">{x.expected_cash !== null ? money(x.expected_cash) : '—'}</td><td className="n">{x.counted_cash !== null ? money(x.counted_cash) : '—'}</td>
                <td className={`n bold ${x.variance < 0 ? 'danger-text' : x.variance > 0 ? 'warning-text' : ''}`}>{x.variance !== null ? money(x.variance) : '—'}</td>
                <td>{x.status === 'open' && can('shifts.close_others') && x.user_id !== current.data?.user_id && <button className="btn sm" onClick={(e) => { e.stopPropagation(); void api('shifts.summary', { id: x.id }).then((d) => setDialog({ kind: 'close', shift: d })); }}>إغلاق</button>}</td>
              </tr>
            ))}</tbody></table>
        )}
      </div>
      {dialog?.kind === 'cash' && <CashMoveDialog onClose={() => { setDialog(null); void current.refetch(); }} />}
      {dialog?.kind === 'close' && <CloseShiftDialog shift={dialog.shift} onClose={() => { setDialog(null); void qc.invalidateQueries({ queryKey: ['shift'] }); void list.refetch(); }} />}
      {dialog?.kind === 'view' && (
        <Modal title={`وردية ${dialog.shift.user_name}`} onClose={() => setDialog(null)} footer={<button className="btn" onClick={() => void api('print.doc', { title: 'تقرير وردية', rows: shiftReportRows(dialog.shift) })}><Printer size={15} /> طباعة</button>}>
          <table className="table"><tbody>{shiftReportRows(dialog.shift).map(([k, v], i) => <tr key={i}><td>{k}</td><td className="n bold">{v}</td></tr>)}</tbody></table>
          {dialog.shift.close_note && <div className="alert info small mt">{dialog.shift.close_note}</div>}
        </Modal>
      )}
    </div>
  );
}

function CashMoveDialog({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<'withdrawal' | 'deposit'>('withdrawal');
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  return (
    <Modal title="حركة نقدية" size="sm" onClose={onClose} footer={<button className="btn primary" disabled={busy || !amount} onClick={() => run(async () => { await api('shifts.cash', { type, amount, note }); onClose(); }, 'تم التسجيل')}>تسجيل</button>}>
      <div className="col">
        <Segmented value={type} onChange={setType} options={[{ value: 'withdrawal', label: <><ArrowUpCircle size={14} /> سحب من الدرج</> }, { value: 'deposit', label: <><ArrowDownCircle size={14} /> إضافة للدرج</> }]} />
        <Field label="المبلغ"><MoneyInput className="lg" autoFocus value={amount} allowEmpty onChange={setAmount} /></Field>
        <Field label="السبب"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثال: توريد للمالك / فكة" /></Field>
      </div>
    </Modal>
  );
}

export function CloseShiftDialog({ shift, onClose }: { shift: any; onClose: () => void }) {
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  const variance = counted === null ? null : counted - shift.expected;
  return (
    <Modal title={`إغلاق وردية ${shift.user_name}`} onClose={onClose} footer={<button className="btn primary lg" disabled={busy || counted === null} onClick={() => run(async () => {
      const r = await api('shifts.close', { shiftId: shift.id, countedCash: counted, note: note || null });
      void api('print.doc', { title: 'تقرير إغلاق وردية (Z)', rows: shiftReportRows(r) }).catch(() => {});
      onClose();
    }, 'تم إغلاق الوردية')}>إغلاق الوردية</button>}>
      <div className="col">
        <div className="alert info">عُدّ النقدية الموجودة في الدرج فعليًا واكتبها هنا. البرنامج سيقارنها بالمتوقع.</div>
        <Field label="النقدية الفعلية في الدرج"><MoneyInput className="lg" autoFocus value={counted} allowEmpty onChange={setCounted} /></Field>
        <div className="grid grid-3">
          <Stat label="المتوقع" value={<span className="num">{money(shift.expected)}</span>} />
          <Stat label="الفعلي" value={<span className="num">{counted === null ? '—' : money(counted)}</span>} />
          <Stat label="الفرق" value={<span className={`num ${variance !== null && variance < 0 ? 'danger-text' : variance ? 'warning-text' : 'success-text'}`}>{variance === null ? '—' : money(variance)}</span>} hint={variance === null ? '' : variance < 0 ? 'عجز' : variance > 0 ? 'زيادة' : 'مطابق ✓'} />
        </div>
        <Field label="ملاحظة"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={variance && variance !== 0 ? 'سبب الفرق إن وجد' : ''} /></Field>
      </div>
    </Modal>
  );
}
