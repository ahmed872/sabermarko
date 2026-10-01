import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Wallet } from 'lucide-react';
import { api } from '../lib/api';
import { dateOnly, money, todayIso } from '../lib/format';
import { DateRangePicker, Empty, Field, Modal, MoneyInput, PageHeader, Stat, presetRange, useAction, useConfirm, type Range } from '../components/ui';
import { BarList } from '../components/Charts';

export default function Expenses() {
  const [range, setRange] = useState<Range>(presetRange('month'));
  const [open, setOpen] = useState(false);
  const confirm = useConfirm();
  const { run } = useAction();
  const list = useQuery({ queryKey: ['expenses', range], queryFn: () => api('expenses.list', range) });
  const total = (list.data?.rows ?? []).reduce((a: number, r: any) => a + r.amount, 0);
  return (
    <div>
      <PageHeader title="المصروفات" sub="كهرباء، إيجار، رواتب، نقل… تُخصم من صافي الربح" icon={<Wallet color="var(--primary)" />} actions={<button className="btn primary" onClick={() => setOpen(true)}><Plus size={16} /> مصروف جديد</button>} />
      <div className="row mb"><DateRangePicker value={range} onChange={setRange} /></div>
      <div className="grid" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        <div className="card">
          {!list.data?.rows.length ? <Empty title="لا توجد مصروفات في هذه الفترة" /> : (
            <table className="table"><thead><tr><th>التاريخ</th><th>البند</th><th>البيان</th><th className="n">المبلغ</th><th>من الدرج</th><th>بواسطة</th><th /></tr></thead>
              <tbody>{list.data.rows.map((e: any) => (
                <tr key={e.id}><td className="num small">{dateOnly(e.business_date)}</td><td className="bold">{e.category_name}</td><td className="small">{e.note ?? ''}</td><td className="n bold">{money(e.amount)}</td><td>{e.paid_from_drawer ? <span className="badge">نعم</span> : ''}</td><td className="small">{e.user_name}</td>
                  <td><button className="btn ghost sm icon" onClick={async () => { const r = await confirm({ title: 'حذف مصروف', message: `حذف مصروف ${money(e.amount)}؟${e.paid_from_drawer ? ' سيُعاد المبلغ للدرج.' : ''}`, danger: true, reason: true, confirmText: 'حذف' }); if (r.ok) void run(async () => { await api('expenses.delete', { id: e.id, reason: r.reason }); void list.refetch(); }); }}><Trash2 size={14} /></button></td></tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={3}>الإجمالي</td><td className="n">{money(total)}</td><td colSpan={3} /></tr></tfoot></table>
          )}
        </div>
        <div className="col">
          <Stat tone="primary" label="إجمالي المصروفات" value={<span className="num">{money(total)}</span>} />
          <div className="card pad"><div className="section-title">حسب البند</div>{list.data?.byCategory.length ? <BarList rows={list.data.byCategory.map((c: any) => ({ label: c.name, value: c.total, display: money(c.total) }))} /> : <span className="muted small">—</span>}</div>
        </div>
      </div>
      {open && <ExpenseDialog onClose={() => { setOpen(false); void list.refetch(); }} />}
    </div>
  );
}

function ExpenseDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ['expenseCats'], queryFn: () => api<any[]>('expenses.categories') });
  const shift = useQuery({ queryKey: ['shift'], queryFn: () => api('shifts.current') });
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayIso());
  const [fromDrawer, setFromDrawer] = useState(false);
  const [newCat, setNewCat] = useState('');
  const { run, busy } = useAction();
  return (
    <Modal title="مصروف جديد" onClose={onClose} footer={<button className="btn primary" disabled={busy || !categoryId || !amount} onClick={() => run(async () => {
      await api('expenses.create', { categoryId, amount, note: note || null, paidFromDrawer: fromDrawer, businessDate: date });
      await qc.invalidateQueries({ queryKey: ['shift'] }); onClose();
    }, 'تم تسجيل المصروف')}>حفظ</button>}>
      <div className="col">
        <Field label="البند">
          <div className="row wrap gap-sm">{(cats.data ?? []).map((c) => <button key={c.id} type="button" className={`btn sm ${categoryId === c.id ? 'primary' : ''}`} onClick={() => setCategoryId(c.id)}>{c.name}</button>)}</div>
        </Field>
        <div className="row"><input className="input" placeholder="بند جديد…" value={newCat} onChange={(e) => setNewCat(e.target.value)} /><button className="btn sm" disabled={!newCat.trim()} onClick={() => run(async () => { const r = await api('expenses.saveCategory', { name: newCat }); setNewCat(''); await cats.refetch(); setCategoryId(r.id); })}>إضافة</button></div>
        <div className="grid grid-2"><Field label="المبلغ"><MoneyInput className="lg" value={amount} allowEmpty onChange={setAmount} /></Field><Field label="التاريخ"><input type="date" className="input lg" value={date} onChange={(e) => setDate(e.target.value)} /></Field></div>
        <Field label="البيان"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثال: فاتورة كهرباء شهر 9" /></Field>
        <label className="check"><input type="checkbox" disabled={!shift.data} checked={fromDrawer} onChange={(e) => setFromDrawer(e.target.checked)} /> صرف من درج الكاشير {shift.data ? `(المتاح ${money(shift.data.expected)})` : '(لا توجد وردية مفتوحة)'}</label>
      </div>
    </Modal>
  );
}
