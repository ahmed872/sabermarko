import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, ClipboardList, Plus, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { dateTime, money, qty } from '../lib/format';
import { Empty, Field, Loading, Modal, PageHeader, QtyInput, Segmented, Stat, useAction, useConfirm } from '../components/ui';

export default function Stocktake() {
  return <Routes><Route index element={<StocktakeList />} /><Route path=":id" element={<StocktakeSheet />} /></Routes>;
}

function StocktakeList() {
  const nav = useNavigate();
  const { feature } = useApp();
  const list = useQuery({ queryKey: ['stocktakes'], queryFn: () => api<any[]>('stocktake.list') });
  const [open, setOpen] = useState(false);
  const status: Record<string, [string, string]> = { open: ['info', 'جاري'], completed: ['success', 'مكتمل'], cancelled: ['', 'ملغي'] };
  return (
    <div>
      <PageHeader title="الجرد" sub="قارن الكمية في النظام بالكمية الفعلية على الرف" icon={<ClipboardList color="var(--primary)" />} actions={<button className="btn primary" onClick={() => setOpen(true)}><Plus size={16} /> بدء جرد جديد</button>} />
      <div className="card">
        {!list.data?.length ? <Empty title="لم يتم أي جرد بعد" desc="ابدأ جردًا كاملًا أو لتصنيف واحد (مثل المشروبات)." /> : (
          <table className="table"><thead><tr><th>الرقم</th><th>التاريخ</th><th>المكان</th><th>النطاق</th><th className="n">تم عدّه</th><th className="n">فروقات</th><th>الحالة</th><th>بواسطة</th></tr></thead>
            <tbody>{list.data.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => nav(`/stocktake/${s.id}`)}>
                <td className="num">{s.doc_no}</td><td className="num small">{dateTime(s.created_at)}</td><td>{s.location_name}</td><td>{s.category_name ?? 'كل المنتجات'}</td>
                <td className="n">{s.counted_items} / {s.total_items}</td><td className="n">{s.status === 'completed' ? s.diff_items : '—'}</td>
                <td><span className={`badge ${status[s.status][0]}`}>{status[s.status][1]}</span></td><td className="small">{s.created_by_name}</td>
              </tr>
            ))}</tbody></table>
        )}
      </div>
      {open && <StartDialog multi={feature('multiLocation')} onClose={() => setOpen(false)} onStarted={(id) => nav(`/stocktake/${id}`)} />}
    </div>
  );
}

function StartDialog({ onClose, onStarted, multi }: { onClose: () => void; onStarted: (id: number) => void; multi: boolean }) {
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('categories.list') });
  const locs = useQuery({ queryKey: ['locations'], queryFn: () => api<any[]>('locations.list'), enabled: multi });
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [locationId, setLocationId] = useState<number | ''>('');
  const { run, busy } = useAction();
  return (
    <Modal title="بدء جرد جديد" size="sm" onClose={onClose} footer={<button className="btn primary" disabled={busy} onClick={() => run(async () => { const r = await api('stocktake.start', { categoryId: categoryId || null, locationId: locationId || null }); onStarted(r.id); })}>بدء الجرد</button>}>
      <div className="col">
        <Field label="ماذا ستجرد؟"><select className="select" value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value) || '')}><option value="">كل المنتجات</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        {multi && <Field label="المكان"><select className="select" value={locationId} onChange={(e) => setLocationId(Number(e.target.value) || '')}><option value="">المكان الافتراضي</option>{(locs.data ?? []).filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
        <div className="alert info small">يمكنك الاستمرار في البيع أثناء الجرد. عند التأكيد يُحسب الفرق مقابل رصيد النظام في لحظة التأكيد، والأصناف التي لم تُعدّ لا تتغير.</div>
      </div>
    </Modal>
  );
}

function StocktakeSheet() {
  const { id } = useParams();
  const sid = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { can } = useApp();
  const { run, busy } = useAction();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'uncounted' | 'diff'>('all');
  const st = useQuery({ queryKey: ['stocktake', sid, q, filter], queryFn: () => api('stocktake.get', { id: sid, q, onlyUncounted: filter === 'uncounted', onlyDiff: filter === 'diff' }), placeholderData: (p) => p });
  const [counts, setCounts] = useState<Record<number, number | null>>({});
  useEffect(() => { if (st.data) setCounts((c) => ({ ...Object.fromEntries(st.data.items.map((i: any) => [i.product_id, i.counted_qty])), ...c })); }, [st.data]);
  if (st.isLoading) return <Loading />;
  const d = st.data;
  const open = d.status === 'open';
  const save = async (productId: number, v: number | null) => {
    try { await api('stocktake.count', { id: sid, productId, qty: v }); void qc.invalidateQueries({ queryKey: ['stocktake', sid] }); } catch (e) { alert((e as Error).message); }
  };
  return (
    <div>
      <PageHeader title={`جرد ${d.doc_no}`} sub={`${d.location_name} — بدأ ${dateTime(d.created_at)} بواسطة ${d.created_by_name}`} icon={<ClipboardList color="var(--primary)" />}
        actions={<>
          <Link className="btn" to="/stocktake">رجوع</Link>
          {open && <button className="btn" onClick={async () => { if ((await confirm({ title: 'إلغاء الجرد', message: 'لن يتغير أي مخزون.', danger: true, confirmText: 'إلغاء الجرد' })).ok) void run(async () => { await api('stocktake.cancel', { id: sid }); nav('/stocktake'); }); }}>إلغاء الجرد</button>}
          {open && <button className="btn primary" disabled={busy} onClick={async () => {
            const r = await confirm({ title: 'تأكيد الجرد', message: <>سيتم إنشاء تسوية مخزون لـ <b>{d.stats.diffs}</b> صنف بفروقات، بقيمة <b>{money(d.stats.diff_value)}</b>. الأصناف غير المعدودة ({d.stats.total - d.stats.counted}) لن تتغير.</>, confirmText: 'تأكيد وتسوية المخزون' });
            if (r.ok) void run(async () => { await api('stocktake.complete', { id: sid }); await qc.invalidateQueries(); }, 'تم اعتماد الجرد وتسجيل الفروقات');
          }}><CheckCircle2 size={16} /> اعتماد الجرد</button>}
        </>} />
      <div className="grid grid-4 mb">
        <Stat label="الأصناف" value={d.stats.total} />
        <Stat label="تم عدّها" value={`${d.stats.counted ?? 0}`} hint={`${Math.round(((d.stats.counted ?? 0) / Math.max(d.stats.total, 1)) * 100)}%`} />
        <Stat label="أصناف بها فرق" value={<span className={d.stats.diffs ? 'danger-text' : ''}>{d.stats.diffs ?? 0}</span>} />
        {can('reports.cost') && <Stat label="قيمة الفرق" value={<span className={`num ${(d.stats.diff_value ?? 0) < 0 ? 'danger-text' : 'success-text'}`}>{money(d.stats.diff_value ?? 0)}</span>} hint="سالب = عجز" />}
      </div>
      <div className="card">
        <div className="row wrap" style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
          <div className="grow" style={{ position: 'relative' }}><Search size={16} style={{ position: 'absolute', right: 10, top: 11, color: 'var(--text-3)' }} /><input className="input" style={{ paddingInlineStart: 32 }} placeholder="بحث أو مسح باركود" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
          <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: 'الكل' }, { value: 'uncounted', label: 'لم يُعدّ' }, { value: 'diff', label: 'بها فرق' }]} />
        </div>
        <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 330px)' }}>
          <table className="table">
            <thead><tr><th>المنتج</th><th>التصنيف</th><th className="n">بالنظام</th><th style={{ width: 170 }}>الفعلي</th><th className="n">الفرق</th>{can('reports.cost') && <th className="n">قيمة الفرق</th>}</tr></thead>
            <tbody>{d.items.map((i: any) => {
              const c = counts[i.product_id];
              const diff = c === null || c === undefined ? null : c - i.system_qty;
              return (
                <tr key={i.product_id}>
                  <td className="bold">{i.name}<div className="xs muted num">{i.barcode ?? i.sku ?? ''}</div></td><td className="small">{i.category_name ?? '—'}</td>
                  <td className="n">{qty(i.system_qty)} <span className="xs muted">{i.unit_symbol}</span></td>
                  <td>{open ? <QtyInput value={c ?? null} allowEmpty onChange={(v) => setCounts((x) => ({ ...x, [i.product_id]: v }))} onBlur={() => void save(i.product_id, counts[i.product_id] ?? null)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} placeholder="—" /> : <span className="num">{c === null || c === undefined ? '—' : qty(c)}</span>}</td>
                  <td className={`n bold ${diff === null ? '' : diff < 0 ? 'danger-text' : diff > 0 ? 'success-text' : ''}`}>{diff === null ? '—' : `${diff > 0 ? '+' : ''}${qty(diff)}`}</td>
                  {can('reports.cost') && <td className="n">{diff ? money(Math.round((diff * i.unit_cost) / 1000)) : '—'}</td>}
                </tr>
              );
            })}</tbody>
          </table>
          {!d.items.length && <Empty title="لا توجد أصناف مطابقة" />}
        </div>
      </div>
    </div>
  );
}
