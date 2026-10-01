import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Coins, Printer } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { METHOD_LABEL, dateOnly, dateTime, money, todayIso } from '../lib/format';
import { Empty, Loading, PageHeader, Stat, useAction, useConfirm } from '../components/ui';

export function summaryRows(s: any, canCost: boolean): [string, string][] {
  return [
    ['عدد الفواتير', String(s.invoices)], ['إجمالي المبيعات قبل الخصم', money(s.grossSales)], ['الخصومات', money(s.discounts)], ['المرتجعات', `${s.returns.count} — ${money(s.returns.total)}`],
    ['صافي المبيعات', money(s.netSales)], ...(s.tax ? [['الضريبة', money(s.tax)] as [string, string]] : []),
    ...(canCost ? [['تكلفة البضاعة المباعة', money(s.cogs)], ['مجمل الربح', money(s.grossProfit)]] as [string, string][] : []),
    ['المصروفات', money(s.expenses)], ...(canCost ? [['صافي الربح', money(s.netProfit)] as [string, string]] : []),
    ...['cash', 'card', 'wallet', 'credit'].map((m) => [`مقبوض ${METHOD_LABEL[m]}`, money(s.payments[m] - (s.refunds[m] ?? 0))] as [string, string]),
    ['متوسط الفاتورة', money(s.avgBasket)],
  ];
}

export default function DayClose() {
  const { can } = useApp();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const [date, setDate] = useState(todayIso());
  const p = useQuery({ queryKey: ['dayPreview', date], queryFn: () => api('day.preview', { date }) });
  const history = useQuery({ queryKey: ['dayClosings'], queryFn: () => api<any[]>('day.list') });
  if (p.isLoading) return <Loading />;
  const d = p.data;
  const s = d.summary;
  const rows = summaryRows(s, can('reports.cost'));
  return (
    <div>
      <PageHeader title="إغلاق اليوم" sub="ملخص اليوم الكامل ومطابقة الخزنة" icon={<Coins color="var(--primary)" />} actions={<>
        <input type="date" className="input" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} style={{ width: 160 }} />
        <button className="btn" onClick={() => void api('print.doc', { title: `ملخص يوم ${dateOnly(date)}`, rows: [...rows, ['فرق الخزنة', money(d.cashVariance)]] })}><Printer size={16} /> طباعة</button>
        {!d.closed && <button className="btn primary" disabled={busy} onClick={async () => {
          const r = await confirm({ title: 'إغلاق اليوم', message: <>{d.openShifts > 0 && <div className="alert warning mb">يوجد {d.openShifts} وردية مفتوحة. يُفضّل إغلاقها أولًا لمطابقة الخزنة.</div>}سيتم حفظ ملخص اليوم وعمل نسخة احتياطية تلقائيًا.</>, confirmText: 'إغلاق اليوم' });
          if (r.ok) void run(async () => { await api('day.close', { date }); await p.refetch(); await history.refetch(); }, 'تم إغلاق اليوم وحفظ نسخة احتياطية');
        }}><CheckCircle2 size={16} /> إغلاق اليوم</button>}
      </>} />
      {d.closed && <div className="alert success mb">تم إغلاق هذا اليوم في {dateTime(d.closed.closed_at)}{d.closed.backup_file ? ' — مع نسخة احتياطية' : ''}.</div>}
      <div className="grid grid-4 mb">
        <Stat tone="primary" label="صافي المبيعات" value={<span className="num">{money(s.netSales)}</span>} hint={`${s.invoices} فاتورة`} />
        {can('reports.cost') && <Stat label="مجمل الربح" value={<span className="num">{money(s.grossProfit)}</span>} hint={s.grossMarginPct !== null ? `هامش ${s.grossMarginPct}%` : ''} />}
        {can('reports.cost') && <Stat label="صافي الربح بعد المصروفات" value={<span className={`num ${s.netProfit < 0 ? 'danger-text' : ''}`}>{money(s.netProfit)}</span>} hint={`مصروفات ${money(s.expenses)}`} />}
        <Stat label="فرق الخزنة" value={<span className={`num ${d.cashVariance < 0 ? 'danger-text' : ''}`}>{money(d.cashVariance)}</span>} hint={d.openShifts ? `${d.openShifts} وردية مفتوحة` : 'كل الورديات مغلقة'} />
      </div>
      <div className="grid grid-2">
        <div className="card"><div className="card-head"><h3>الملخص المالي</h3></div><table className="table"><tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td className="n bold">{v}</td></tr>)}</tbody></table></div>
        <div className="col">
          <div className="card"><div className="card-head"><h3>الورديات</h3></div>
            {!d.shifts.length ? <Empty title="لا توجد ورديات" /> : <table className="table"><thead><tr><th>الكاشير</th><th>الحالة</th><th className="n">المتوقع</th><th className="n">الفعلي</th><th className="n">الفرق</th></tr></thead>
              <tbody>{d.shifts.map((x: any) => <tr key={x.id}><td>{x.user_name}</td><td>{x.status === 'open' ? <span className="badge warning">مفتوحة</span> : <span className="badge success">مغلقة</span>}</td><td className="n">{x.expected_cash !== null ? money(x.expected_cash) : '—'}</td><td className="n">{x.counted_cash !== null ? money(x.counted_cash) : '—'}</td><td className={`n bold ${x.variance < 0 ? 'danger-text' : ''}`}>{x.variance !== null ? money(x.variance) : '—'}</td></tr>)}</tbody></table>}
          </div>
          <div className="card pad small">
            <div className="section-title">حركات أخرى في اليوم</div>
            <div>المشتريات: {d.purchases.count} فاتورة — {money(d.purchases.total)} (المدفوع {money(d.purchases.paid)})</div>
            {d.collections.map((c: any, i: number) => <div key={i}>{c.party_type === 'customer' ? 'تحصيل من عملاء' : 'سداد لموردين'} ({METHOD_LABEL[c.method]}): {money(c.amount)}</div>)}
          </div>
        </div>
      </div>
      <div className="card mt">
        <div className="card-head"><h3>الأيام المغلقة</h3></div>
        {!history.data?.length ? <Empty title="لم يتم إغلاق أي يوم بعد" /> : <table className="table"><thead><tr><th>اليوم</th><th className="n">الفواتير</th><th className="n">صافي المبيعات</th>{can('reports.cost') && <th className="n">صافي الربح</th>}<th>أغلق بواسطة</th><th>نسخة احتياطية</th></tr></thead>
          <tbody>{history.data.map((h) => <tr key={h.id} className="clickable" onClick={() => setDate(h.business_date)}><td className="num bold">{dateOnly(h.business_date)}</td><td className="n">{h.summary.invoices}</td><td className="n">{money(h.summary.netSales)}</td>{can('reports.cost') && <td className="n">{money(h.summary.netProfit)}</td>}<td className="small">{h.closed_by_name}</td><td>{h.backup_file ? '✓' : '—'}</td></tr>)}</tbody></table>}
      </div>
    </div>
  );
}
