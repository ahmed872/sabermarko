import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PackageSearch, Plus, Trash2, Truck } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { dateOnly, money, qty as fmtQty } from '../lib/format';
import { Empty, Field, Loading, MoneyInput, PageHeader, QtyInput, useAction, useConfirm } from '../components/ui';
import { ProductPicker } from '../components/ProductPicker';
import { loadPurchaseLine, type PLine } from './PurchaseForm';

const STATUS: Record<string, [string, string]> = { open: ['info', 'مفتوح'], partial: ['warning', 'استلام جزئي'], received: ['success', 'تم الاستلام'], cancelled: ['', 'ملغي'] };

export default function PurchaseOrders() {
  return <Routes><Route index element={<POList />} /><Route path="new" element={<POForm />} /><Route path=":id" element={<PODetail />} /></Routes>;
}

function POList() {
  const nav = useNavigate();
  const { can } = useApp();
  const list = useQuery({ queryKey: ['pos'], queryFn: () => api<any[]>('po.list', {}) });
  return (
    <div>
      <PageHeader title="طلبات الشراء" sub="اطلب البضاعة من المورد — المخزون لا يتغير إلا عند الاستلام" icon={<PackageSearch color="var(--primary)" />} actions={can('purchase_orders.manage') && <Link className="btn primary" to="/purchase-orders/new"><Plus size={16} /> طلب شراء جديد</Link>} />
      <div className="card">
        {!list.data?.length ? <Empty title="لا توجد طلبات شراء" /> : (
          <table className="table"><thead><tr><th>الرقم</th><th>المورد</th><th>التاريخ</th><th>الاستلام المتوقع</th><th className="n">الأصناف</th><th className="n">القيمة</th><th>الحالة</th></tr></thead>
            <tbody>{list.data.map((p) => <tr key={p.id} className="clickable" onClick={() => nav(`/purchase-orders/${p.id}`)}><td className="num bold">{p.po_no}</td><td>{p.supplier_name}</td><td className="num small">{dateOnly(p.created_at)}</td><td className="num small">{dateOnly(p.expected_date)}</td><td className="n">{p.items_count}</td><td className="n">{money(p.total)}</td><td><span className={`badge ${STATUS[p.status][0]}`}>{STATUS[p.status][1]}</span></td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  );
}

function POForm() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const { run, busy } = useAction();
  const suppliers = useQuery({ queryKey: ['suppliers', 'pick'], queryFn: () => api<any[]>('suppliers.list', {}) });
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<PLine[]>([]);
  useEffect(() => {
    if (!params.get('fromReorder')) return;
    const draft = JSON.parse(sessionStorage.getItem('reorderDraft') ?? '[]') as any[];
    sessionStorage.removeItem('reorderDraft');
    Promise.all(draft.map((r) => loadPurchaseLine(r.productId, r.purchaseUnitId ?? undefined, r.purchaseUnits * 1000))).then(setLines);
    const sup = draft.find((r) => r.supplierId)?.supplierId;
    if (sup) setSupplierId(sup);
  }, [params]);
  const upd = (i: number, p: Partial<PLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const total = lines.reduce((a, l) => a + Math.round(((l.unitCost ?? 0) * (l.qty ?? 0)) / 1000), 0);
  return (
    <div>
      <PageHeader title="طلب شراء جديد" icon={<PackageSearch color="var(--primary)" />} />
      <div className="col gap-lg">
        <div className="card pad form-grid">
          <Field label="المورد *"><select className="select" value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value) || '')}><option value="">اختر المورد</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="تاريخ الاستلام المتوقع"><input type="date" className="input" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
          <Field label="ملاحظات" className="span-2"><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <div className="card">
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}><ProductPicker autoFocus onPick={async (p) => setLines([...lines, await loadPurchaseLine(p.id)])} /></div>
          <table className="table"><thead><tr><th>المنتج</th><th>الوحدة</th><th>الكمية</th><th>السعر المتوقع</th><th className="n">الإجمالي</th><th /></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={i}><td className="bold">{l.name}</td>
                <td style={{ width: 160 }}><select className="select" value={l.unitId} onChange={(e) => upd(i, { unitId: Number(e.target.value) })}>{l.units.map((u) => <option key={u.unit_id} value={u.unit_id}>{u.unit_name}{u.factor !== 1000 ? ` (${fmtQty(u.factor)})` : ''}</option>)}</select></td>
                <td style={{ width: 130 }}><QtyInput value={l.qty} allowEmpty onChange={(v) => upd(i, { qty: v })} /></td>
                <td style={{ width: 140 }}><MoneyInput value={l.unitCost} allowEmpty onChange={(v) => upd(i, { unitCost: v })} /></td>
                <td className="n">{money(Math.round(((l.unitCost ?? 0) * (l.qty ?? 0)) / 1000))}</td>
                <td><button className="btn ghost sm icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td></tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={4}>الإجمالي المتوقع</td><td className="n">{money(total)}</td><td /></tr></tfoot>
          </table>
        </div>
        <div className="row"><button className="btn primary lg" disabled={busy || !supplierId || !lines.length} onClick={() => run(async () => {
          const r = await api('po.save', { data: { supplierId, expectedDate: expected || null, notes: notes || null, lines: lines.filter((l) => l.qty).map((l) => ({ productId: l.productId, unitId: l.unitId, qty: l.qty, unitCost: l.unitCost ?? 0 })) } });
          await qc.invalidateQueries({ queryKey: ['pos'] }); nav(`/purchase-orders/${r.id}`, { replace: true });
        }, 'تم حفظ طلب الشراء')}>حفظ الطلب</button><button className="btn lg" onClick={() => nav(-1)}>إلغاء</button></div>
      </div>
    </div>
  );
}

function PODetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useApp();
  const confirm = useConfirm();
  const { run } = useAction();
  const po = useQuery({ queryKey: ['po', Number(id)], queryFn: () => api('po.get', { id: Number(id) }) });
  if (po.isLoading) return <Loading />;
  const d = po.data;
  const open = ['open', 'partial'].includes(d.status);
  return (
    <div>
      <PageHeader title={<>طلب شراء {d.po_no} <span className={`badge ${STATUS[d.status][0]}`}>{STATUS[d.status][1]}</span></>} sub={`${d.supplier_name}${d.supplier_phone ? ` — ${d.supplier_phone}` : ''}`} icon={<PackageSearch color="var(--primary)" />}
        actions={<>
          <Link className="btn" to="/purchase-orders">رجوع</Link>
          {open && can('purchase_orders.manage') && <button className="btn" onClick={async () => { if ((await confirm({ title: 'إلغاء الطلب', message: 'لن يتأثر المخزون.', confirmText: 'إلغاء الطلب', danger: true })).ok) void run(async () => { await api('po.cancel', { id: d.id }); await qc.invalidateQueries({ queryKey: ['po'] }); void po.refetch(); }); }}>إلغاء الطلب</button>}
          {open && can('purchases.manage') && <button className="btn primary" onClick={() => nav(`/purchases/new?po=${d.id}`)}><Truck size={16} /> استلام البضاعة</button>}
        </>} />
      <div className="card">
        <table className="table"><thead><tr><th>المنتج</th><th>الوحدة</th><th className="n">المطلوب</th><th className="n">المستلم</th><th className="n">المتبقي</th><th className="n">السعر المتوقع</th></tr></thead>
          <tbody>{d.items.map((i: any) => <tr key={i.id}><td className="bold">{i.product_name}{i.variant_name ? ` ${i.variant_name}` : ''}</td><td>{i.unit_name}</td><td className="n">{fmtQty(i.qty)}</td><td className="n">{fmtQty(i.received_qty)}</td><td className="n bold">{fmtQty(Math.max(0, i.qty - i.received_qty))}</td><td className="n">{money(i.unit_cost)}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={5}>القيمة المتوقعة</td><td className="n">{money(d.total)}</td></tr></tfoot></table>
      </div>
      {d.receipts.length > 0 && <div className="card pad mt small">فواتير الاستلام: {d.receipts.map((r: any) => `${r.purchase_no} (${money(r.total)})`).join('، ')}</div>}
    </div>
  );
}
