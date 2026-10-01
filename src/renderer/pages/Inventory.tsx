import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeftRight, Boxes, PackageMinus, ShoppingCart, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { dateOnly, dateTime, money, num, qty } from '../lib/format';
import { DateRangePicker, Empty, Field, Loading, Modal, PageHeader, QtyInput, Segmented, Stat, Tabs, presetRange, useAction, type Range } from '../components/ui';
import { ProductPicker, type PickedProduct } from '../components/ProductPicker';

export const MOVEMENT_LABEL: Record<string, string> = {
  opening: 'رصيد افتتاحي', purchase: 'شراء', sale: 'بيع', sale_return: 'مرتجع بيع', purchase_return: 'مرتجع شراء', stocktake: 'جرد',
  damage: 'تلف', loss: 'فقد', adjustment: 'تسوية', transfer_in: 'تحويل وارد', transfer_out: 'تحويل صادر', void: 'إلغاء فاتورة',
};

type Tab = 'stock' | 'low' | 'movements' | 'docs' | 'expiry';

export default function Inventory() {
  const loc = useLocation();
  const nav = useNavigate();
  const { can, feature } = useApp();
  const tab: Tab = (loc.pathname.split('/')[2] as Tab) || 'stock';
  const [dialog, setDialog] = useState<null | 'adjust' | 'transfer'>(null);
  return (
    <div>
      <PageHeader title="المخزون" icon={<Boxes color="var(--primary)" />} actions={<>
        {can('inventory.adjust') && <button className="btn" onClick={() => setDialog('adjust')}><PackageMinus size={16} /> تلف / فقد / تسوية</button>}
        {feature('multiLocation') && can('inventory.transfer') && <button className="btn" onClick={() => setDialog('transfer')}><ArrowLeftRight size={16} /> تحويل بين الأماكن</button>}
        {can('inventory.stocktake') && <Link className="btn primary" to="/stocktake">الجرد</Link>}
      </>} />
      <Tabs value={tab} onChange={(t) => nav(t === 'stock' ? '/inventory' : `/inventory/${t}`)} tabs={[
        { value: 'stock', label: 'المخزون الحالي' },
        { value: 'low', label: 'النواقص واقتراحات الطلب' },
        { value: 'movements', label: 'حركات المخزون' },
        { value: 'docs', label: 'التلف والتسويات' },
        { value: 'expiry', label: 'الصلاحية', hidden: !feature('expiry') },
      ]} />
      {tab === 'stock' && <StockTab />}
      {tab === 'low' && <LowTab />}
      {tab === 'movements' && <MovementsTab />}
      {tab === 'docs' && <DocsTab />}
      {tab === 'expiry' && <ExpiryTab />}
      {dialog === 'adjust' && <AdjustDialog onClose={() => setDialog(null)} />}
      {dialog === 'transfer' && <TransferDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

function StockTab() {
  const { can } = useApp();
  const v = useQuery({ queryKey: ['valuation'], queryFn: () => api('reports.valuation') });
  if (v.isLoading) return <Loading />;
  const d = v.data;
  return (
    <div className="col gap-lg">
      <div className="grid grid-4">
        <Stat label="عدد المنتجات النشطة" value={num(d.products)} />
        {can('reports.cost') && <Stat tone="primary" label="قيمة المخزون بالتكلفة" value={<span className="num">{money(d.cost_value)}</span>} hint="رأس المال الموجود في البضاعة" />}
        <Stat label="قيمة المخزون بسعر البيع" value={<span className="num">{money(d.retail_value)}</span>} />
        <Stat label="منتجات رصيدها بالسالب" value={<Link to="/products?stock=negative" className={d.negative_count ? 'danger-text' : ''}>{num(d.negative_count)}</Link>} hint="تحتاج جرد أو تسجيل مشتريات" />
      </div>
      <div className="card">
        <div className="card-head"><h3>المخزون حسب التصنيف</h3><div className="grow" /><Link to="/products" className="btn sm">كل المنتجات</Link></div>
        <table className="table"><thead><tr><th>التصنيف</th><th className="n">المنتجات</th>{can('reports.cost') && <th className="n">القيمة بالتكلفة</th>}<th className="n">القيمة بسعر البيع</th></tr></thead>
          <tbody>{d.byCategory.map((c: any) => <tr key={c.name}><td>{c.name}</td><td className="n">{c.products}</td>{can('reports.cost') && <td className="n">{money(c.cost_value)}</td>}<td className="n">{money(c.retail_value)}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}

function LowTab() {
  const { can, feature } = useApp();
  const nav = useNavigate();
  const low = useQuery({ queryKey: ['lowStock'], queryFn: () => api<any[]>('reports.lowStock') });
  const reorder = useQuery({ queryKey: ['reorder'], queryFn: () => api<any[]>('reports.reorder', {}) });
  const urgency: Record<string, [string, string]> = { high: ['danger', 'عاجل'], medium: ['warning', 'قريبًا'], low: ['info', 'للمتابعة'] };
  return (
    <div className="col gap-lg">
      <div className="card">
        <div className="card-head"><ShoppingCart size={18} /><h3>اقتراحات الطلب من الموردين</h3><span className="muted small">بناءً على متوسط البيع اليومي آخر 30 يوم ومدة توريد المورد — البرنامج يقترح فقط ولا يطلب تلقائيًا</span></div>
        {reorder.isLoading ? <Loading /> : !reorder.data?.length ? <Empty title="لا توجد اقتراحات حاليًا" desc="المخزون يغطي البيع المتوقع." /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>المنتج</th><th className="n">المخزون</th><th className="n">يبيع يوميًا</th><th className="n">يكفي</th><th>المورد</th><th className="n">الكمية المقترحة</th>{can('reports.cost') && <th className="n">التكلفة التقريبية</th>}<th /></tr></thead>
            <tbody>{reorder.data.map((r) => (
              <tr key={r.productId}>
                <td className="bold"><Link to={`/products/${r.productId}`}>{r.name}</Link></td>
                <td className="n">{qty(r.stock)} <span className="xs muted">{r.unitSymbol}</span></td>
                <td className="n">{qty(r.dailyVelocity)}</td>
                <td className="n">{r.daysLeft === null ? '—' : `${r.daysLeft} يوم`}</td>
                <td>{r.supplierName ?? <span className="muted">—</span>}</td>
                <td className="n bold">{num(r.purchaseUnits)} {r.purchaseUnit}{r.purchaseFactor !== 1000 ? <span className="xs muted"> ({qty(r.suggestedBaseQty)} {r.unitSymbol})</span> : null}</td>
                {can('reports.cost') && <td className="n">{r.estimatedCost ? money(r.estimatedCost) : '—'}</td>}
                <td><span className={`badge ${urgency[r.urgency][0]}`}>{urgency[r.urgency][1]}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {!!reorder.data?.length && can('purchases.manage') && (
          <div className="row" style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
            <button className="btn primary" onClick={() => { sessionStorage.setItem('reorderDraft', JSON.stringify(reorder.data)); nav(feature('purchaseOrders') ? '/purchase-orders/new?fromReorder=1' : '/purchases/new?fromReorder=1'); }}>
              {feature('purchaseOrders') ? 'إنشاء طلب شراء من الاقتراحات' : 'فتح فاتورة شراء بالاقتراحات'}
            </button>
            <span className="muted small">يمكنك تعديل الكميات قبل الحفظ.</span>
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-head"><AlertTriangle size={18} color="var(--warning)" /><h3>منتجات وصلت للحد الأدنى</h3></div>
        {!low.data?.length ? <Empty title="لا توجد نواقص" desc="حدد (الحد الأدنى) في كل منتج ليظهر التنبيه هنا." /> : (
          <table className="table"><thead><tr><th>المنتج</th><th className="n">المخزون</th><th className="n">الحد الأدنى</th><th>المورد</th></tr></thead>
            <tbody>{low.data.map((p) => <tr key={p.id}><td className="bold"><Link to={`/products/${p.id}`}>{p.name}{p.variant_name ? ` ${p.variant_name}` : ''}</Link></td><td className={`n bold ${p.stock <= 0 ? 'danger-text' : 'warning-text'}`}>{qty(p.stock)} {p.unit_symbol}</td><td className="n">{qty(p.min_stock)}</td><td>{p.supplier_name ?? '—'}</td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  );
}

function MovementsTab() {
  const [range, setRange] = useState<Range>(presetRange('week'));
  const [type, setType] = useState('');
  const m = useQuery({ queryKey: ['movements', range, type], queryFn: () => api('inventory.movements', { ...range, type: type || null, limit: 500 }) });
  return (
    <div className="card">
      <div className="row wrap" style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <DateRangePicker value={range} onChange={setRange} />
        <select className="select" style={{ width: 170 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">كل الحركات</option>{Object.entries(MOVEMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {m.data?.totals?.length > 0 && <div className="row wrap" style={{ padding: '10px 12px', gap: 16 }}>{m.data.totals.map((t: any) => <span key={t.type} className="small"><b>{MOVEMENT_LABEL[t.type]}</b>: {t.cnt} حركة</span>)}</div>}
      {m.isLoading ? <Loading /> : !m.data?.rows.length ? <Empty title="لا توجد حركات في هذه الفترة" /> : (
        <div className="table-wrap" style={{ maxHeight: 600 }}><table className="table">
          <thead><tr><th>التاريخ</th><th>المنتج</th><th>الحركة</th><th className="n">الكمية</th><th className="n">قبل</th><th className="n">بعد</th><th>المكان</th><th>المستخدم</th><th>ملاحظة</th></tr></thead>
          <tbody>{m.data.rows.map((r: any) => (
            <tr key={r.id}><td className="num small">{dateTime(r.created_at)}</td><td className="bold">{r.product_name}</td><td><span className={`badge ${r.qty > 0 ? 'success' : 'danger'}`}>{MOVEMENT_LABEL[r.type]}</span></td>
              <td className={`n bold ${r.qty > 0 ? 'success-text' : 'danger-text'}`}>{r.qty > 0 ? '+' : ''}{qty(r.qty)} <span className="xs muted">{r.unit_symbol}</span></td><td className="n muted">{qty(r.qty_before)}</td><td className="n">{qty(r.qty_after)}</td>
              <td className="small">{r.location_name}</td><td className="small">{r.user_name ?? '—'}</td><td className="small muted">{r.note ?? ''}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function DocsTab() {
  const { can } = useApp();
  const docs = useQuery({ queryKey: ['invdocs'], queryFn: () => api<any[]>('inventory.docs', {}) });
  const types: Record<string, string> = { opening: 'رصيد افتتاحي', damage: 'تلف', loss: 'فقد', adjustment: 'تسوية', transfer: 'تحويل', stocktake: 'جرد' };
  return (
    <div className="card">
      {!docs.data?.length ? <Empty title="لا توجد مستندات" desc="سجّل التالف والمفقود من زر (تلف / فقد / تسوية) — لا يتغير المخزون بدون سبب." /> : (
        <table className="table"><thead><tr><th>الرقم</th><th>النوع</th><th>التاريخ</th><th>المكان</th><th className="n">الأصناف</th>{can('reports.cost') && <th className="n">القيمة</th>}<th>السبب</th><th>المستخدم</th></tr></thead>
          <tbody>{docs.data.map((d) => <tr key={d.id}><td className="num">{d.doc_no}</td><td>{types[d.type]}</td><td className="num small">{dateTime(d.created_at)}</td><td>{d.from_location}{d.to_location ? ` ← ${d.to_location}` : ''}</td><td className="n">{d.lines}</td>{can('reports.cost') && <td className="n">{d.value ? money(Math.abs(d.value)) : '—'}</td>}<td className="small">{d.reason ?? ''}</td><td className="small">{d.user_name}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

function ExpiryTab() {
  const [days, setDays] = useState(30);
  const e = useQuery({ queryKey: ['expiring', days], queryFn: () => api<any[]>('reports.expiring', { days }) });
  const { can } = useApp();
  return (
    <div className="card">
      <div className="row" style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <span>تنتهي خلال</span>
        <Segmented value={String(days)} onChange={(v) => setDays(Number(v))} options={[{ value: '7', label: '7 أيام' }, { value: '30', label: '30 يوم' }, { value: '60', label: '60 يوم' }, { value: '90', label: '90 يوم' }]} />
      </div>
      {!e.data?.length ? <Empty title="لا توجد منتجات قريبة من الانتهاء" /> : (
        <table className="table"><thead><tr><th>المنتج</th><th>الدفعة</th><th>تاريخ الانتهاء</th><th className="n">المتبقي</th><th className="n">الكمية</th>{can('reports.cost') && <th className="n">القيمة</th>}<th>المكان</th></tr></thead>
          <tbody>{e.data.map((b) => (
            <tr key={b.id}><td className="bold"><Link to={`/products/${b.product_id}`}>{b.name}{b.variant_name ? ` ${b.variant_name}` : ''}</Link></td><td>{b.batch_no ?? '—'}</td><td className="num">{dateOnly(b.expiry_date)}</td>
              <td className="n">{b.days_left < 0 ? <span className="badge danger">منتهي منذ {-b.days_left} يوم</span> : <span className={`badge ${b.days_left <= 7 ? 'danger' : 'warning'}`}>{b.days_left} يوم</span>}</td>
              <td className="n bold">{qty(b.qty)} {b.unit_symbol}</td>{can('reports.cost') && <td className="n">{money(Math.round((b.qty * b.unit_cost) / 1000))}</td>}<td>{b.location_name}</td></tr>
          ))}</tbody></table>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ adjustments */
interface AdjLine { product: PickedProduct; qty: number | null; dir: 1 | -1; expiry: string }

export function AdjustDialog({ onClose, preset }: { onClose: () => void; preset?: { id: number; name: string; unit: string; stock: number } }) {
  const { feature } = useApp();
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const [type, setType] = useState<'damage' | 'loss' | 'adjustment' | 'opening'>('damage');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<AdjLine[]>(preset ? [{ product: { id: preset.id, name: preset.name, variant_name: null, sell_price: 0, avg_cost: null, unit_symbol: preset.unit, stock: preset.stock, barcode: null, allow_decimal: 1 }, qty: null, dir: -1, expiry: '' }] : []);
  const labels = { damage: 'تلف (منتهي/مكسور)', loss: 'فقد / سرقة', adjustment: 'تسوية (زيادة أو نقص)', opening: 'إضافة رصيد افتتاحي' };
  const save = () => run(async () => {
    const valid = lines.filter((l) => l.qty && l.qty > 0);
    if (!valid.length) throw new Error('أدخل كمية لصنف واحد على الأقل');
    if (!reason.trim() && type !== 'opening') throw new Error('اكتب سبب الحركة');
    await api('inventory.adjust', {
      type, reason: reason || labels[type],
      lines: valid.map((l) => ({ productId: l.product.id, qty: type === 'adjustment' ? l.qty! * l.dir : l.qty!, expiryDate: l.expiry || null })),
    });
    await qc.invalidateQueries();
    onClose();
  }, 'تم تسجيل الحركة في سجل المخزون');
  return (
    <Modal title="تعديل المخزون" size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>إلغاء</button><button className="btn primary" disabled={busy} onClick={save}>حفظ الحركة</button></>}>
      <div className="col">
        <div className="alert info small">لا يتم تغيير المخزون بصمت: كل تعديل يُسجل في سجل الحركة مع السبب والمستخدم والوقت. للفرق في العدّ استخدم صفحة <Link to="/stocktake">الجرد</Link>.</div>
        <Segmented value={type} onChange={setType} options={(Object.keys(labels) as (keyof typeof labels)[]).map((k) => ({ value: k, label: labels[k] }))} />
        {!preset && <ProductPicker autoFocus onPick={(p) => setLines((ls) => (ls.some((l) => l.product.id === p.id) ? ls : [...ls, { product: p, qty: null, dir: -1, expiry: '' }]))} />}
        {lines.length > 0 && (
          <table className="table"><thead><tr><th>المنتج</th><th className="n">المخزون الحالي</th>{type === 'adjustment' && <th>الاتجاه</th>}<th>الكمية</th>{type === 'opening' && feature('expiry') && <th>الصلاحية</th>}<th /></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={l.product.id}><td className="bold">{l.product.name}</td><td className="n">{qty(l.product.stock)} {l.product.unit_symbol}</td>
                {type === 'adjustment' && <td><Segmented value={l.dir === 1 ? 'up' : 'down'} onChange={(v) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, dir: v === 'up' ? 1 : -1 } : x)))} options={[{ value: 'down', label: 'نقص' }, { value: 'up', label: 'زيادة' }]} /></td>}
                <td style={{ width: 160 }}><QtyInput autoFocus={!!preset} value={l.qty} allowEmpty onChange={(v) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: v } : x)))} suffix={l.product.unit_symbol} /></td>
                {type === 'opening' && feature('expiry') && <td><input type="date" className="input" value={l.expiry} onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, expiry: e.target.value } : x)))} /></td>}
                <td>{!preset && <button className="btn ghost sm icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={14} /></button>}</td></tr>
            ))}</tbody></table>
        )}
        <Field label="السبب"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثال: علب منتهية الصلاحية / كسر أثناء النقل" /></Field>
      </div>
    </Modal>
  );
}

function TransferDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const locs = useQuery({ queryKey: ['locations'], queryFn: () => api<any[]>('locations.list') });
  const [from, setFrom] = useState<number | ''>('');
  const [to, setTo] = useState<number | ''>('');
  const [lines, setLines] = useState<{ product: PickedProduct; qty: number | null }[]>([]);
  const active = (locs.data ?? []).filter((l) => l.active);
  return (
    <Modal title="تحويل بضاعة بين الأماكن" size="lg" onClose={onClose} footer={<button className="btn primary" disabled={busy || !from || !to || !lines.length} onClick={() => run(async () => {
      await api('inventory.transfer', { fromLocationId: from, toLocationId: to, lines: lines.filter((l) => l.qty).map((l) => ({ productId: l.product.id, qty: l.qty })) });
      await qc.invalidateQueries(); onClose();
    }, 'تم التحويل')}>تحويل</button>}>
      <div className="col">
        <div className="grid grid-2">
          <Field label="من"><select className="select" value={from} onChange={(e) => setFrom(Number(e.target.value) || '')}><option value="">اختر</option>{active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
          <Field label="إلى"><select className="select" value={to} onChange={(e) => setTo(Number(e.target.value) || '')}><option value="">اختر</option>{active.filter((l) => l.id !== from).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        </div>
        {active.length < 2 && <div className="alert warning">أضف مكانًا آخر (مخزن/ثلاجة) من الإعدادات ← أماكن التخزين.</div>}
        <ProductPicker onPick={(p) => setLines((ls) => [...ls, { product: p, qty: null }])} />
        {lines.map((l, i) => (
          <div key={i} className="row"><span className="grow bold">{l.product.name}</span><div style={{ width: 170 }}><QtyInput value={l.qty} allowEmpty onChange={(v) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, qty: v } : x)))} suffix={l.product.unit_symbol} /></div>
            <button className="btn ghost sm icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div>
        ))}
      </div>
    </Modal>
  );
}

