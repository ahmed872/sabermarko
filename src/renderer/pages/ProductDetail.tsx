import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, Edit, History, PackagePlus, Star, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { dateOnly, dateTime, money, packQty, qty } from '../lib/format';
import { Empty, Loading, PageHeader, Stat, Tabs, useAction, useConfirm } from '../components/ui';
import { MOVEMENT_LABEL } from './Inventory';
import { AdjustDialog } from './Inventory';

export default function ProductDetail() {
  const { id } = useParams();
  const pid = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can, feature } = useApp();
  const confirm = useConfirm();
  const { run } = useAction();
  const [tab, setTab] = useState<'ledger' | 'prices' | 'suppliers' | 'batches'>('ledger');
  const [adjust, setAdjust] = useState(false);
  const p = useQuery({ queryKey: ['product', pid], queryFn: () => api('products.get', { id: pid }) });
  const ledger = useQuery({ queryKey: ['ledger', pid], queryFn: () => api<any[]>('inventory.ledger', { productId: pid, limit: 300 }), enabled: tab === 'ledger' && can('inventory.view') });
  const history = useQuery({ queryKey: ['priceHistory', pid], queryFn: () => api<any[]>('products.priceHistory', { id: pid }), enabled: tab === 'prices' });
  const sup = useQuery({ queryKey: ['supplierPrices', pid], queryFn: () => api<any[]>('products.supplierPrices', { id: pid }), enabled: tab === 'suppliers' && can('purchases.view') });
  const batches = useQuery({ queryKey: ['batches', pid], queryFn: () => api<any[]>('inventory.batches', { productId: pid }), enabled: tab === 'batches' });
  if (p.isLoading) return <Loading />;
  if (!p.data) return <Empty title="المنتج غير موجود" />;
  const d = p.data;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['product', pid] }); void qc.invalidateQueries({ queryKey: ['ledger', pid] }); void qc.invalidateQueries({ queryKey: ['products'] }); };
  return (
    <div>
      <PageHeader title={<>{d.name}{d.variant_name ? ` ${d.variant_name}` : ''} {!d.active && <span className="badge">موقوف</span>}</>}
        sub={[d.category_name, d.brand_name, d.barcode && `باركود ${d.barcode}`, d.sku && `كود ${d.sku}`].filter(Boolean).join(' • ')}
        actions={<>
          {can('products.manage') && <button className="btn" onClick={() => run(async () => { await api('products.favorite', { id: pid, favorite: !d.is_favorite }); refresh(); })}><Star size={16} fill={d.is_favorite ? 'var(--accent)' : 'none'} /> {d.is_favorite ? 'إزالة من السريعة' : 'منتج سريع'}</button>}
          {can('inventory.adjust') && <button className="btn" onClick={() => setAdjust(true)}><PackagePlus size={16} /> تعديل المخزون</button>}
          {can('products.manage') && <Link className="btn primary" to={`/products/${pid}/edit`}><Edit size={16} /> تعديل</Link>}
          {can('products.delete') && (d.active
            ? <button className="btn" onClick={async () => { if ((await confirm({ title: 'إيقاف المنتج', message: 'لن يظهر المنتج في البيع، وتبقى كل التقارير السابقة كما هي.', confirmText: 'إيقاف' })).ok) void run(async () => { await api('products.setActive', { id: pid, active: false }); refresh(); }, 'تم إيقاف المنتج'); }}><Archive size={16} /> إيقاف</button>
            : <button className="btn" onClick={() => run(async () => { await api('products.setActive', { id: pid, active: true }); refresh(); }, 'تم تفعيل المنتج')}>تفعيل</button>)}
          {can('products.delete') && <button className="btn danger outline icon" title="حذف" onClick={async () => { if ((await confirm({ title: 'حذف المنتج نهائيًا', message: 'يُسمح بالحذف فقط إذا لم يكن للمنتج أي حركات أو فواتير. خلاف ذلك استخدم "إيقاف".', confirmText: 'حذف', danger: true })).ok) void run(async () => { await api('products.delete', { id: pid }); nav('/products'); }, 'تم حذف المنتج'); }}><Trash2 size={16} /></button>}
        </>} />
      <div className="grid grid-4 mb">
        <Stat label="سعر البيع" value={<span className="num">{money(d.sell_price)}</span>} hint={`لكل ${d.unit_name}`} />
        {d.avg_cost !== null && <Stat label="متوسط التكلفة" value={<span className="num">{money(Math.round(d.avg_cost))}</span>} hint={d.sell_price > 0 ? `هامش ${(((d.sell_price - d.avg_cost) / d.sell_price) * 100).toFixed(1)}%` : undefined} />}
        <Stat label="المخزون الحالي" value={<span className={`num ${d.totalQty < 0 ? 'danger-text' : ''}`}>{qty(d.totalQty)} {d.unit_symbol}</span>} hint={[d.pack_factor && Math.abs(d.totalQty) >= d.pack_factor ? packQty(d.totalQty, d.pack_factor, d.pack_symbol, d.unit_symbol) : '', d.min_stock > 0 ? `الحد الأدنى ${qty(d.min_stock)}` : ''].filter(Boolean).join(' — ') || undefined} />
        {d.avg_cost !== null && <Stat label="قيمة المخزون (بالتكلفة)" value={<span className="num">{money(Math.max(0, Math.round((d.totalQty * d.avg_cost) / 1000)))}</span>} />}
      </div>
      {(d.units.length > 1 || d.stock.length > 1 || d.variants.length > 0) && (
        <div className="grid grid-3 mb">
          {d.units.length > 1 && <div className="card pad"><div className="section-title">الوحدات</div>{d.units.map((u: any) => <div key={u.unit_id} className="row between small"><span>{u.unit_name}{u.barcode ? ` (${u.barcode})` : ''}</span><span className="num">= {qty(u.factor)} {d.unit_symbol} — {money(u.sell_price ?? Math.round((d.sell_price * u.factor) / 1000))}</span></div>)}</div>}
          {d.stock.length > 1 && <div className="card pad"><div className="section-title">المخزون حسب المكان</div>{d.stock.map((s: any) => <div key={s.location_id} className="row between small"><span>{s.name}</span><span className="num">{qty(s.qty)}</span></div>)}</div>}
          {d.variants.length > 0 && <div className="card pad"><div className="section-title">أحجام/أنواع أخرى من {d.group_name}</div>{d.variants.map((v: any) => <Link key={v.id} to={`/products/${v.id}`} className="row between small"><span>{v.variant_name || v.name}</span><span className="num">{money(v.sell_price)}</span></Link>)}</div>}
        </div>
      )}
      <div className="card">
        <div style={{ padding: '0 14px' }}>
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: 'ledger', label: 'سجل حركة المخزون', hidden: !can('inventory.view') },
            { value: 'prices', label: 'تاريخ الأسعار' },
            { value: 'suppliers', label: 'أسعار الموردين', hidden: !can('purchases.view') },
            { value: 'batches', label: 'الدفعات والصلاحية', hidden: !feature('expiry') || !d.track_expiry },
          ]} />
        </div>
        {tab === 'ledger' && (ledger.isLoading ? <Loading /> : !ledger.data?.length ? <Empty title="لا توجد حركات بعد" icon={<History size={24} />} /> : (
          <div className="table-wrap" style={{ maxHeight: 520 }}>
            <table className="table">
              <thead><tr><th>التاريخ</th><th>الحركة</th><th>المرجع</th><th className="n">الكمية</th><th className="n">قبل</th><th className="n">بعد</th><th>المستخدم</th><th>ملاحظة</th></tr></thead>
              <tbody>{ledger.data.map((m) => (
                <tr key={m.id}>
                  <td className="num small">{dateTime(m.created_at)}</td>
                  <td><span className={`badge ${m.qty > 0 ? 'success' : 'danger'}`}>{MOVEMENT_LABEL[m.type] ?? m.type}</span></td>
                  <td className="num small">{m.ref_no ?? '—'}</td>
                  <td className={`n bold ${m.qty > 0 ? 'success-text' : 'danger-text'}`}>{m.qty > 0 ? '+' : ''}{qty(m.qty)}</td>
                  <td className="n muted">{qty(m.qty_before)}</td><td className="n">{qty(m.qty_after)}</td>
                  <td className="small">{m.user_name ?? '—'}</td><td className="small muted">{m.note ?? ''}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ))}
        {tab === 'prices' && (!history.data?.length ? <Empty title="لا يوجد تاريخ أسعار" /> : (
          <table className="table"><thead><tr><th>التاريخ</th><th>النوع</th><th className="n">السعر السابق</th><th className="n">السعر الجديد</th><th>المورد</th><th>المستخدم</th></tr></thead>
            <tbody>{history.data.map((h) => (
              <tr key={h.id}><td className="num small">{dateTime(h.created_at)}</td><td>{h.kind === 'sell' ? 'سعر بيع' : 'سعر شراء'}</td>
                <td className="n muted">{h.old_price === null ? '—' : money(Math.round(h.old_price))}</td><td className="n bold">{money(Math.round(h.new_price))}</td>
                <td>{h.supplier_name ?? '—'}</td><td className="small">{h.user_name ?? '—'}</td></tr>
            ))}</tbody></table>
        ))}
        {tab === 'suppliers' && (!sup.data?.length ? <Empty title="لم يُشترَ هذا المنتج من أي مورد بعد" /> : (
          <table className="table"><thead><tr><th>المورد</th><th className="n">آخر سعر</th><th>الوحدة</th><th className="n">التكلفة لكل {d.unit_symbol}</th><th>آخر شراء</th><th className="n">مرات الشراء</th></tr></thead>
            <tbody>{sup.data.map((s, i) => (
              <tr key={s.supplier_id}><td className="bold">{s.supplier_name} {i === 0 && sup.data!.length > 1 && <span className="badge success">الأرخص</span>}</td>
                <td className="n">{money(s.unit_cost)}</td><td>{s.unit_name}</td><td className="n bold">{money(Math.round(s.base_cost))}</td><td className="num">{dateOnly(s.purchase_date)}</td><td className="n">{s.times}</td></tr>
            ))}</tbody></table>
        ))}
        {tab === 'batches' && (!batches.data?.length ? <Empty title="لا توجد دفعات" /> : (
          <table className="table"><thead><tr><th>رقم الدفعة</th><th>تاريخ الانتهاء</th><th>المكان</th><th className="n">المتبقي</th><th className="n">الكمية المستلمة</th><th>تاريخ الاستلام</th></tr></thead>
            <tbody>{batches.data.map((b) => (
              <tr key={b.id}><td>{b.batch_no ?? '—'}</td><td className="num">{dateOnly(b.expiry_date)}</td><td>{b.location_name}</td><td className="n bold">{qty(b.qty)}</td><td className="n muted">{qty(b.initial_qty)}</td><td className="num small">{dateTime(b.received_at)}</td></tr>
            ))}</tbody></table>
        ))}
      </div>
      {adjust && <AdjustDialog preset={{ id: pid, name: d.name, unit: d.unit_symbol, stock: d.totalQty }} onClose={() => { setAdjust(false); refresh(); }} />}
    </div>
  );
}
