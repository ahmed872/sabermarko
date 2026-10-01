import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, RotateCcw, ShoppingCart } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { dateOnly, dateTime, money, qty } from '../lib/format';
import { DateRangePicker, Empty, Field, Loading, Modal, PageHeader, QtyInput, Segmented, Stat, Tabs, presetRange, useAction, type Range } from '../components/ui';

export default function Purchases() {
  const { can } = useApp();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'list' | 'returns'>('list');
  const [range, setRange] = useState<Range>(presetRange('month'));
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<number | null>(Number(params.get('open')) || null);
  useEffect(() => { if (params.get('open')) setParams({}, { replace: true }); }, [params, setParams]);
  const list = useQuery({ queryKey: ['purchases', range, q], queryFn: () => api('purchases.list', { ...range, q }), enabled: tab === 'list' });
  const rets = useQuery({ queryKey: ['purchaseReturns', range], queryFn: () => api<any[]>('purchases.returns', range), enabled: tab === 'returns' });
  return (
    <div>
      <PageHeader title="المشتريات" icon={<ShoppingCart color="var(--primary)" />} actions={can('purchases.manage') && <Link className="btn primary" to="/purchases/new"><Plus size={16} /> شراء جديد</Link>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'list', label: 'فواتير الشراء' }, { value: 'returns', label: 'مرتجعات الشراء' }]} />
      <div className="row wrap mb"><DateRangePicker value={range} onChange={setRange} />{tab === 'list' && <input className="input" style={{ width: 240 }} placeholder="رقم الفاتورة أو المورد" value={q} onChange={(e) => setQ(e.target.value)} />}</div>
      {tab === 'list' && (
        <>
          {list.data && <div className="grid grid-3 mb"><Stat label="عدد الفواتير" value={list.data.sum.count} /><Stat label="إجمالي المشتريات" value={<span className="num">{money(list.data.sum.total)}</span>} /><Stat label="المدفوع / المتبقي" value={<span className="num">{money(list.data.sum.paid)}</span>} hint={`المتبقي ${money(list.data.sum.total - list.data.sum.paid)}`} /></div>}
          <div className="card">
            {list.isLoading ? <Loading /> : !list.data?.rows.length ? <Empty title="لا توجد مشتريات في هذه الفترة" action={can('purchases.manage') && <Link className="btn primary" to="/purchases/new">تسجيل أول فاتورة شراء</Link>} /> : (
              <table className="table"><thead><tr><th>الرقم</th><th>التاريخ</th><th>المورد</th><th>فاتورة المورد</th><th className="n">الأصناف</th><th className="n">الإجمالي</th><th className="n">المدفوع</th><th className="n">المتبقي</th></tr></thead>
                <tbody>{list.data.rows.map((p: any) => (
                  <tr key={p.id} className="clickable" onClick={() => setOpenId(p.id)}>
                    <td className="num bold">{p.purchase_no}</td><td className="num small">{dateOnly(p.purchase_date)}</td><td>{p.supplier_name ?? <span className="muted">نقدي</span>}</td><td className="num small">{p.supplier_invoice_no ?? '—'}</td>
                    <td className="n">{p.items_count}</td><td className="n bold">{money(p.total)}</td><td className="n">{money(p.paid)}</td><td className={`n ${p.remaining > 0 ? 'danger-text' : ''}`}>{money(p.remaining)}</td>
                  </tr>
                ))}</tbody></table>
            )}
          </div>
        </>
      )}
      {tab === 'returns' && (
        <div className="card">
          {!rets.data?.length ? <Empty title="لا توجد مرتجعات شراء" desc="افتح فاتورة الشراء واضغط (مرتجع للمورد)." /> : (
            <table className="table"><thead><tr><th>الرقم</th><th>التاريخ</th><th>المورد</th><th>فاتورة الشراء</th><th className="n">القيمة</th><th>الاسترداد</th><th>السبب</th></tr></thead>
              <tbody>{rets.data.map((r) => <tr key={r.id}><td className="num">{r.return_no}</td><td className="num small">{dateTime(r.created_at)}</td><td>{r.supplier_name ?? '—'}</td><td className="num">{r.purchase_no ?? '—'}</td><td className="n bold">{money(r.total)}</td><td>{r.refund_method === 'cash' ? 'نقدي' : 'خصم من الحساب'}</td><td className="small">{r.reason ?? ''}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
      {openId && <PurchaseDetail id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function PurchaseDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { can } = useApp();
  const [ret, setRet] = useState(false);
  const p = useQuery({ queryKey: ['purchase', id], queryFn: () => api('purchases.get', { id }) });
  if (!p.data) return null;
  const d = p.data;
  return (
    <Modal title={`فاتورة شراء ${d.purchase_no}`} size="xl" onClose={onClose} footer={<>{can('purchases.manage') && <button className="btn" onClick={() => setRet(true)}><RotateCcw size={15} /> مرتجع للمورد</button>}<div className="grow" /><button className="btn" onClick={onClose}>إغلاق</button></>}>
      <div className="col">
        <div className="row wrap small" style={{ gap: 20 }}>
          <span>المورد: <b>{d.supplier_name ?? 'نقدي'}</b></span><span>التاريخ: <b className="num">{dateOnly(d.purchase_date)}</b></span>
          {d.supplier_invoice_no && <span>فاتورة المورد: <b>{d.supplier_invoice_no}</b></span>}{d.po_no && <span>من طلب: <b>{d.po_no}</b></span>}<span>بواسطة: {d.user_name}</span>
        </div>
        <table className="table"><thead><tr><th>المنتج</th><th className="n">الكمية</th><th>الوحدة</th><th className="n">سعر الوحدة</th><th className="n">خصم</th><th className="n">الإجمالي</th><th>الصلاحية</th><th className="n">مرتجع</th></tr></thead>
          <tbody>{d.items.map((i: any) => <tr key={i.id}><td className="bold">{i.product_name}</td><td className="n">{qty(i.qty)}</td><td>{i.unit_name}</td><td className="n">{money(i.unit_cost)}</td><td className="n">{i.discount ? money(i.discount) : '—'}</td><td className="n bold">{money(i.total)}</td><td className="num small">{i.expiry_date ? dateOnly(i.expiry_date) : '—'}</td><td className="n">{i.returned_base_qty ? qty(i.returned_base_qty) : '—'}</td></tr>)}</tbody>
          <tfoot>
            <tr><td colSpan={5}>الإجمالي{d.discount ? ` (بعد خصم ${money(d.discount)})` : ''}{d.tax ? ` + ${money(d.tax)} ضريبة/مصاريف` : ''}</td><td className="n">{money(d.total)}</td><td colSpan={2} /></tr>
            <tr><td colSpan={5}>المدفوع</td><td className="n">{money(d.paid)}</td><td colSpan={2} className="danger-text">{d.total - d.paid > 0 ? `المتبقي ${money(d.total - d.paid)}` : ''}</td></tr>
          </tfoot>
        </table>
        {d.returns.length > 0 && <div className="small">المرتجعات: {d.returns.map((r: any) => `${r.return_no} (${money(r.total)})`).join('، ')}</div>}
        {d.notes && <div className="alert info small">{d.notes}</div>}
      </div>
      {ret && <PurchaseReturnDialog purchase={d} onClose={() => { setRet(false); void p.refetch(); }} />}
    </Modal>
  );
}

function PurchaseReturnDialog({ purchase, onClose }: { purchase: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const [qtys, setQtys] = useState<Record<number, number | null>>({});
  const [method, setMethod] = useState<'balance' | 'cash'>(purchase.supplier_id ? 'balance' : 'cash');
  const [reason, setReason] = useState('');
  const lines = purchase.items.filter((i: any) => (qtys[i.id] ?? 0) > 0);
  const total = lines.reduce((a: number, i: any) => a + Math.round((Math.round(i.landed_total * 1000 / i.qty) * (qtys[i.id] ?? 0)) / 1000), 0);
  return (
    <Modal title="مرتجع للمورد" size="lg" onClose={onClose} footer={<button className="btn primary" disabled={busy || !lines.length} onClick={() => run(async () => {
      await api('purchases.return', { purchaseId: purchase.id, refundMethod: method, reason, lines: lines.map((i: any) => ({ purchaseItemId: i.id, productId: i.product_id, unitId: i.unit_id, qty: qtys[i.id], unitCost: Math.round((i.landed_total * 1000) / i.qty) })) });
      await qc.invalidateQueries(); onClose();
    }, 'تم تسجيل مرتجع الشراء وخصم الكمية من المخزون')}>تسجيل المرتجع ({money(total)})</button>}>
      <div className="col">
        <table className="table"><thead><tr><th>المنتج</th><th className="n">المشترى</th><th>كمية المرتجع</th></tr></thead>
          <tbody>{purchase.items.map((i: any) => <tr key={i.id}><td>{i.product_name}</td><td className="n">{qty(i.qty)} {i.unit_name}</td><td style={{ width: 170 }}><QtyInput value={qtys[i.id] ?? null} allowEmpty onChange={(v) => setQtys((q) => ({ ...q, [i.id]: v }))} suffix={i.unit_name} /></td></tr>)}</tbody></table>
        <Field label="طريقة الاسترداد"><Segmented value={method} onChange={setMethod} options={[...(purchase.supplier_id ? [{ value: 'balance' as const, label: 'خصم من حساب المورد' }] : []), { value: 'cash', label: 'استلام نقدي' }]} /></Field>
        <Field label="السبب"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: بضاعة تالفة / قريبة الانتهاء" /></Field>
      </div>
    </Modal>
  );
}

