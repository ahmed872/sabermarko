import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Ban, FileText, Printer, Receipt, RotateCcw, Search } from 'lucide-react';
import { api, apiApproved } from '../lib/api';
import { useApp } from '../lib/app';
import { METHOD_LABEL, dateOnly, dateTime, money, qty, todayIso } from '../lib/format';
import { DateRangePicker, Empty, Field, Loading, Modal, PageHeader, Pager, QtyInput, Segmented, Stat, Tabs, presetRange, useAction, useConfirm, useToast, type Range } from '../components/ui';

type Tab = 'invoices' | 'returns' | 'quotations';

export default function Sales({ tab: initial = 'invoices' }: { tab?: Tab }) {
  const { can, feature } = useApp();
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>(initial);
  const [range, setRange] = useState<Range>(presetRange('today'));
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [userId, setUserId] = useState<number | ''>('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<number | null>(null);
  const [findNo, setFindNo] = useState('');
  const toast = useToast();
  const users = useQuery({ queryKey: ['userNames'], queryFn: () => api<any[]>('users.names'), enabled: can('sales.view_all') });
  const list = useQuery({ queryKey: ['sales', range, q, status, userId, page], queryFn: () => api('sales.list', { ...range, q, status: status || null, userId: userId || null, page, pageSize: 50 }), enabled: tab === 'invoices', placeholderData: (p) => p });
  const rets = useQuery({ queryKey: ['returns', range], queryFn: () => api<any[]>('returns.list', range), enabled: tab === 'returns' });
  const quotes = useQuery({ queryKey: ['quotations'], queryFn: () => api<any[]>('quotations.list'), enabled: tab === 'quotations' });
  const find = async () => {
    if (!findNo.trim()) return;
    try { const s = await api('sales.find', { invoiceNo: findNo.trim() }); setOpenId(s.id); setFindNo(''); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div>
      <PageHeader title="المبيعات" icon={<Receipt color="var(--primary)" />} actions={
        <form className="row" onSubmit={(e) => { e.preventDefault(); void find(); }}>
          <input className="input" style={{ width: 220 }} placeholder="رقم الفاتورة (للمرتجع أو الطباعة)" value={findNo} onChange={(e) => setFindNo(e.target.value)} />
          <button className="btn"><Search size={16} /> فتح</button>
        </form>} />
      <Tabs value={tab} onChange={(t) => { setTab(t); setPage(1); }} tabs={[{ value: 'invoices', label: 'الفواتير' }, { value: 'returns', label: 'المرتجعات' }, { value: 'quotations', label: 'عروض الأسعار', hidden: !feature('quotations') || !can('quotations.manage') }]} />
      {tab !== 'quotations' && (
        <div className="row wrap mb">
          <DateRangePicker value={range} onChange={(r) => { setRange(r); setPage(1); }} />
          {tab === 'invoices' && <>
            <input className="input" style={{ width: 200 }} placeholder="رقم / عميل / هاتف" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            <select className="select" style={{ width: 130 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">كل الحالات</option><option value="completed">مكتملة</option><option value="voided">ملغاة</option></select>
            {can('sales.view_all') && <select className="select" style={{ width: 160 }} value={userId} onChange={(e) => setUserId(Number(e.target.value) || '')}><option value="">كل الكاشير</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>}
          </>}
        </div>
      )}
      {tab === 'invoices' && (
        <>
          {list.data && <div className="grid grid-3 mb"><Stat label="عدد الفواتير" value={list.data.total} /><Stat label="إجمالي الفواتير المكتملة" value={<span className="num">{money(list.data.sum)}</span>} /><Stat label="متوسط الفاتورة" value={<span className="num">{money(list.data.total ? Math.round(list.data.sum / list.data.total) : 0)}</span>} /></div>}
          <div className="card">
            {list.isLoading ? <Loading /> : !list.data?.rows.length ? <Empty title="لا توجد فواتير في هذه الفترة" /> : (
              <>
                <table className="table"><thead><tr><th>رقم الفاتورة</th><th>الوقت</th><th>الكاشير</th><th>العميل</th><th className="n">الأصناف</th><th className="n">الخصم</th><th className="n">الإجمالي</th><th>الدفع</th><th /></tr></thead>
                  <tbody>{list.data.rows.map((s: any) => (
                    <tr key={s.id} className="clickable" onClick={() => setOpenId(s.id)}>
                      <td className="num bold">{s.invoice_no}</td><td className="num small">{dateTime(s.created_at)}</td><td>{s.cashier_name}</td><td>{s.customer_name ?? <span className="muted">نقدي</span>}</td>
                      <td className="n">{s.items_count}</td><td className="n">{s.discount ? money(s.discount) : '—'}</td><td className="n bold">{money(s.total)}</td>
                      <td className="small">{(s.methods ?? '').split(',').filter(Boolean).map((m: string) => METHOD_LABEL[m]).join(' + ')}</td>
                      <td>{s.status === 'voided' ? <span className="badge danger">ملغاة</span> : s.returned > 0 ? <span className="badge warning">مرتجع {money(s.returned)}</span> : null}</td>
                    </tr>
                  ))}</tbody></table>
                <Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
              </>
            )}
          </div>
        </>
      )}
      {tab === 'returns' && (
        <div className="card">
          {!rets.data?.length ? <Empty title="لا توجد مرتجعات في هذه الفترة" desc="لعمل مرتجع: افتح الفاتورة بالرقم واضغط (مرتجع)." /> : (
            <table className="table"><thead><tr><th>رقم المرتجع</th><th>الوقت</th><th>الفاتورة</th><th>العميل</th><th className="n">الأصناف</th><th className="n">القيمة</th><th>الرد</th><th>السبب</th><th>بواسطة</th></tr></thead>
              <tbody>{rets.data.map((r) => <tr key={r.id}><td className="num bold">{r.return_no}</td><td className="num small">{dateTime(r.created_at)}</td><td className="num">{r.invoice_no}</td><td>{r.customer_name ?? '—'}</td><td className="n">{r.items_count}</td><td className="n bold">{money(r.total)}</td><td>{METHOD_LABEL[r.refund_method] ?? 'رصيد العميل'}</td><td className="small">{r.reason ?? ''}</td><td className="small">{r.user_name}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
      {tab === 'quotations' && (
        <div className="card">
          {!quotes.data?.length ? <Empty title="لا توجد عروض أسعار" desc="من شاشة البيع: أضف الأصناف ثم اضغط (عرض سعر)." icon={<FileText size={26} />} /> : (
            <table className="table"><thead><tr><th>الرقم</th><th>التاريخ</th><th>العميل</th><th className="n">الإجمالي</th><th>صالح حتى</th><th>الحالة</th><th /></tr></thead>
              <tbody>{quotes.data.map((qt) => (
                <tr key={qt.id}><td className="num bold">{qt.quote_no}</td><td className="num small">{dateOnly(qt.created_at)}</td><td>{qt.customer_name ?? '—'}</td><td className="n bold">{money(qt.total)}</td>
                  <td className="num small">{qt.valid_until ? <span className={qt.valid_until < todayIso() ? 'danger-text' : ''}>{dateOnly(qt.valid_until)}</span> : '—'}</td>
                  <td>{qt.status === 'open' ? <span className="badge info">مفتوح</span> : qt.status === 'converted' ? <span className="badge success">تحول لفاتورة {qt.invoice_no}</span> : <span className="badge">ملغي</span>}</td>
                  <td>{qt.status === 'open' && <div className="row gap-sm"><button className="btn sm primary" onClick={() => nav(`/pos?quotation=${qt.id}`)}>تحويل لفاتورة</button><button className="btn sm" onClick={() => void api('quotations.cancel', { id: qt.id }).then(() => quotes.refetch())}>إلغاء</button></div>}</td></tr>
              ))}</tbody></table>
          )}
        </div>
      )}
      {openId && <SaleDetail id={openId} onClose={() => { setOpenId(null); void list.refetch(); }} />}
    </div>
  );
}

export function SaleDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { can, settings } = useApp();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const toast = useToast();
  const { run } = useAction();
  const [ret, setRet] = useState(false);
  const s = useQuery({ queryKey: ['sale', id], queryFn: () => api('sales.get', { id }) });
  if (!s.data) return null;
  const d = s.data;
  const voidable = d.status === 'completed' && !d.returns.length && d.business_date === todayIso();
  const print = (mode: 'print' | 'pdf') => run(async () => { await api('print.sale', { id, mode, copy: true }); if (mode === 'print') toast('تم الإرسال للطابعة', 'success'); });
  return (
    <Modal title={<>فاتورة {d.invoice_no} {d.status === 'voided' && <span className="badge danger">ملغاة</span>}</>} size="xl" onClose={onClose}
      footer={<>
        <button className="btn" onClick={() => print('print')}><Printer size={15} /> إعادة طباعة</button>
        <button className="btn" onClick={() => print('pdf')}>PDF</button>
        <div className="grow" />
        {d.status === 'completed' && settings['sales.allowReturns'] && <button className="btn" onClick={() => setRet(true)}><RotateCcw size={15} /> مرتجع</button>}
        {voidable && <button className="btn danger outline" onClick={async () => {
          const r = await confirm({ title: 'إلغاء الفاتورة', message: <>سيتم إرجاع الكميات للمخزون وعكس المبلغ من الدرج{d.credit_amount ? ' ومن حساب العميل' : ''}. <b>هذه العملية تُسجل في سجل العمليات.</b></>, danger: true, reason: true, confirmText: 'إلغاء الفاتورة' });
          if (r.ok) void run(async () => { await apiApproved('sales.void', { saleId: id, reason: r.reason }); await qc.invalidateQueries(); void s.refetch(); }, 'تم إلغاء الفاتورة');
        }}><Ban size={15} /> إلغاء الفاتورة</button>}
      </>}>
      <div className="col">
        <div className="row wrap small" style={{ gap: 20 }}>
          <span>التاريخ: <b className="num">{dateTime(d.created_at)}</b></span><span>الكاشير: <b>{d.cashier_name}</b></span>
          <span>العميل: <b>{d.customer_name ?? 'نقدي'}</b></span>{d.approved_by_name && <span>موافقة: {d.approved_by_name}</span>}
          {d.status === 'voided' && <span className="danger-text">ألغيت بواسطة {d.voided_by_name} — {d.void_reason}</span>}
        </div>
        <table className="table">
          <thead><tr><th>الصنف</th><th className="n">الكمية</th><th className="n">السعر</th><th className="n">الخصم</th><th className="n">الإجمالي</th>{can('reports.cost') && <th className="n">التكلفة</th>}<th className="n">مرتجع</th></tr></thead>
          <tbody>{d.items.map((i: any) => (
            <tr key={i.id}><td className="bold">{i.product_name}{i.unit_price !== i.original_price && <span className="badge warning" style={{ marginInlineStart: 6 }}>سعر معدل من {money(i.original_price)}</span>}</td>
              <td className="n">{qty(i.qty)} {i.unit_symbol}</td><td className="n">{money(i.unit_price)}</td><td className="n">{i.discount + i.promo_discount + i.invoice_discount_share ? money(i.discount + i.promo_discount + i.invoice_discount_share) : '—'}</td>
              <td className="n bold">{money(i.total)}</td>{can('reports.cost') && <td className="n muted">{money(i.cost_total)}</td>}<td className="n">{i.returned_base_qty ? qty(Math.round((i.returned_base_qty * 1000) / i.factor)) : '—'}</td></tr>
          ))}</tbody>
          <tfoot>
            <tr><td colSpan={4}>الإجمالي قبل الخصم</td><td className="n">{money(d.subtotal)}</td><td colSpan={2} /></tr>
            {d.line_discount + d.invoice_discount > 0 && <tr><td colSpan={4}>الخصومات</td><td className="n">- {money(d.line_discount + d.invoice_discount)}</td><td colSpan={2} /></tr>}
            {d.tax_total > 0 && <tr><td colSpan={4}>الضريبة</td><td className="n">{money(d.tax_total)}</td><td colSpan={2} /></tr>}
            <tr><td colSpan={4}>الإجمالي</td><td className="n">{money(d.total)}</td>{can('reports.cost') && <td className="n">ربح {money(d.net_revenue - d.cogs)}</td>}<td /></tr>
          </tfoot>
        </table>
        <div className="row wrap small" style={{ gap: 16 }}>
          {d.payments.map((p: any) => <span key={p.method}>{METHOD_LABEL[p.method]}: <b>{money(p.amount)}</b></span>)}
          {d.change_due > 0 && <span>الباقي: <b>{money(d.change_due)}</b></span>}
        </div>
        {d.returns.length > 0 && <div className="alert warning small">مرتجعات: {d.returns.map((r: any) => `${r.return_no} (${money(r.total)}) — ${dateTime(r.created_at)}`).join('، ')}</div>}
        {d.business_date !== todayIso() && d.status === 'completed' && <div className="muted xs">الإلغاء متاح لفواتير اليوم فقط. للفواتير الأقدم استخدم المرتجع.</div>}
      </div>
      {ret && <ReturnDialog sale={d} onClose={() => { setRet(false); void s.refetch(); void qc.invalidateQueries({ queryKey: ['shift'] }); }} />}
    </Modal>
  );
}

function ReturnDialog({ sale, onClose }: { sale: any; onClose: () => void }) {
  const { run, busy } = useAction();
  const toast = useToast();
  const items = sale.items.filter((i: any) => i.base_qty > i.returned_base_qty);
  const [qtys, setQtys] = useState<Record<number, number | null>>({});
  const [restock, setRestock] = useState<Record<number, boolean>>({});
  const [method, setMethod] = useState<'cash' | 'card' | 'wallet' | 'credit'>(sale.credit_amount > 0 && sale.customer_id ? 'credit' : 'cash');
  const [reason, setReason] = useState('');
  const remaining = (i: any) => Math.round(((i.base_qty - i.returned_base_qty) * 1000) / i.factor);
  const estimate = items.reduce((a: number, i: any) => a + Math.round((i.total * (qtys[i.id] ?? 0)) / i.qty), 0);
  const submit = () => run(async () => {
    const lines = items.filter((i: any) => (qtys[i.id] ?? 0) > 0).map((i: any) => ({ saleItemId: i.id, qty: qtys[i.id], restock: restock[i.id] !== false }));
    if (!lines.length) throw new Error('حدد كمية المرتجع');
    const r = await apiApproved('returns.create', { saleId: sale.id, items: lines, refundMethod: method, reason: reason || null });
    toast(`تم المرتجع ${r.return_no} — رد ${money(r.total)}`, 'success');
    void api('print.return', { id: r.id }).catch(() => {});
    onClose();
  });
  return (
    <Modal title={`مرتجع من الفاتورة ${sale.invoice_no}`} size="lg" onClose={onClose} footer={<><span className="muted">قيمة تقريبية: <b>{money(estimate)}</b></span><div className="grow" /><button className="btn primary" disabled={busy} onClick={submit}>تأكيد المرتجع</button></>}>
      <div className="col">
        <table className="table"><thead><tr><th>الصنف</th><th className="n">المتاح للمرتجع</th><th>الكمية المرتجعة</th><th>يرجع للمخزون؟</th></tr></thead>
          <tbody>{items.map((i: any) => (
            <tr key={i.id}><td className="bold">{i.product_name}<div className="xs muted">{money(i.unit_price)} / {i.unit_symbol}</div></td><td className="n">{qty(remaining(i))} {i.unit_symbol}</td>
              <td style={{ width: 170 }}><div className="row gap-sm"><QtyInput value={qtys[i.id] ?? null} allowEmpty onChange={(v) => setQtys((x) => ({ ...x, [i.id]: v }))} /><button className="btn sm" onClick={() => setQtys((x) => ({ ...x, [i.id]: remaining(i) }))}>الكل</button></div></td>
              <td><label className="check small"><input type="checkbox" checked={restock[i.id] !== false} onChange={(e) => setRestock((x) => ({ ...x, [i.id]: e.target.checked }))} /> {restock[i.id] === false ? 'تالف (لا يرجع)' : 'سليم'}</label></td></tr>
          ))}</tbody></table>
        <Field label="طريقة رد المبلغ"><Segmented value={method} onChange={setMethod} options={[{ value: 'cash', label: 'نقدي من الدرج' }, { value: 'card', label: 'كارت' }, { value: 'wallet', label: 'محفظة' }, ...(sale.customer_id ? [{ value: 'credit' as const, label: 'خصم من حساب العميل' }] : [])]} /></Field>
        <Field label="السبب"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: المنتج تالف / العميل غيّر رأيه" /></Field>
      </div>
    </Modal>
  );
}
