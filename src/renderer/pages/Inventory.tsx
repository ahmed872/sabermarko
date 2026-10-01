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

const TIER: Record<string, { label: string; tone: string }> = {
  expired: { label: 'منتهي', tone: 'danger' }, critical: { label: 'قريب جدًا', tone: 'danger' }, near: { label: 'قريب', tone: 'warning' }, watch: { label: 'متابعة', tone: 'info' },
};
const ACTION: Record<string, string> = { dispose: 'إعدام (لا يُباع)', return: 'مراجعة إرجاع للمورد', promote: 'عرض تصريف آمن', monitor: 'متابعة فقط' };

/** Expiry dashboard: tiers → batch details → owner decides (return to supplier / dispose). Nothing is automatic. */
function ExpiryTab() {
  const [tier, setTier] = useState<string>('all');
  const [ret, setRet] = useState<any | null>(null);
  const e = useQuery({ queryKey: ['expiry-overview'], queryFn: () => api<any>('inventory.expiry') });
  const { can } = useApp();
  const { run } = useAction();
  const qc = useQueryClient();
  if (!e.data) return <Loading />;
  const t = e.data.thresholds;
  const hint: Record<string, string> = { expired: 'لا تُباع', critical: `خلال ${t.critical} أيام`, near: `خلال ${t.near} يومًا`, watch: `خلال ${t.watch} يومًا` };
  const rows = (e.data.items as any[]).filter((i) => tier === 'all' || i.tier === tier);
  const dispose = (b: any) => run(async () => {
    if (!window.confirm(`تسجيل ${qty(b.qty)} ${b.unit_symbol} من ${b.name} كتالف (منتهي الصلاحية)؟`)) return;
    await api('inventory.adjust', { type: 'damage', locationId: b.location_id, reason: 'منتهي الصلاحية — إعدام', lines: [{ productId: b.product_id, qty: b.qty }] });
    await qc.invalidateQueries();
  }, 'تم تسجيل الكمية كتالف');
  return (
    <div className="col">
      <div className="grid grid-4">
        {(e.data.summary as any[]).map((s) => (
          <button key={s.tier} type="button" className={`card stat clickable ${tier === s.tier ? 'primary' : ''}`} style={{ textAlign: 'start' }} onClick={() => setTier(tier === s.tier ? 'all' : s.tier)}>
            <div className="label"><span className={`badge ${TIER[s.tier].tone}`}>{TIER[s.tier].label}</span> {hint[s.tier]}</div>
            <div className="value">{num(s.products)} منتج</div>
            <div className="hint">{num(s.batches)} دفعة{s.value !== null ? ` • ${money(s.value)}` : ''}</div>
          </button>
        ))}
      </div>
      <div className="card">
        {!rows.length ? <Empty title="لا توجد دفعات في هذه الحالة" /> : (
          <table className="table"><thead><tr><th>المنتج</th><th>الدفعة</th><th>المورد</th><th>الصلاحية</th><th className="n">المتبقي</th><th className="n">الكمية</th>
            {can('reports.cost') && <th className="n">تكلفة/قيمة</th>}<th className="n">البيع يوميًا</th><th>المقترح</th><th /></tr></thead>
            <tbody>{rows.map((b) => (
              <tr key={b.batch_id}>
                <td className="bold"><Link to={`/products/${b.product_id}`}>{b.name}{b.variant_name ? ` ${b.variant_name}` : ''}</Link><div className="xs muted">{b.location_name}</div></td>
                <td className="small">#{b.batch_id}{b.batch_no ? ` • ${b.batch_no}` : ''}<div className="xs muted num">استلام {dateOnly(b.received_at)}{b.purchase_no ? <> • <span dir="ltr">{b.purchase_no}</span></> : null}</div></td>
                <td className="small">{b.supplier_name ?? '—'}</td>
                <td className="num">{dateOnly(b.expiry_date)}</td>
                <td className="n"><span className={`badge ${TIER[b.tier].tone}`}>{b.days_left < 0 ? `منتهي منذ ${-b.days_left} يوم` : `${b.days_left} يوم`}</span></td>
                <td className="n bold">{qty(b.qty)} {b.unit_symbol}</td>
                {can('reports.cost') && <td className="n small">{money(Math.round(b.unit_cost))}<div className="bold">{money(b.value)}</div></td>}
                <td className="n small">{qty(b.perDay)}</td>
                <td className="small">{ACTION[b.action]}{b.unsold > 0 && b.tier !== 'expired' ? <div className="xs muted">لن يُباع منها تقريبًا {qty(b.unsold)}</div> : null}</td>
                <td className="row" style={{ gap: 4 }}>
                  {can('purchases.manage') && <button className="btn sm" onClick={() => setRet(b)}>إرجاع للمورد</button>}
                  {b.tier === 'expired' && can('inventory.adjust') && <button className="btn sm danger outline" onClick={() => dispose(b)}>إعدام</button>}
                </td>
              </tr>
            ))}</tbody></table>
        )}
      </div>
      {ret && <SupplierReturnDialog batch={ret} onClose={() => { setRet(null); void qc.invalidateQueries(); }} />}
    </div>
  );
}

const RETURN_REASONS = ['قرب انتهاء الصلاحية', 'منتهي الصلاحية', 'تالف من المصدر', 'خطأ في التوريد', 'أخرى'];

/** Return a quantity of ONE batch to its supplier (purchase return tied to the batch). */
export function SupplierReturnDialog({ batch: b, onClose }: { batch: any; onClose: () => void }) {
  const { run, busy } = useAction();
  const suppliers = useQuery({ queryKey: ['suppliers-pick'], queryFn: () => api<any[]>('suppliers.list', { limit: 500 }) });
  const [supplierId, setSupplierId] = useState<number | ''>(b.supplier_id ?? '');
  const [q, setQ] = useState<number | null>(b.qty);
  const [reason, setReason] = useState(b.days_left < 0 ? 'منتهي الصلاحية' : 'قرب انتهاء الصلاحية');
  const [method, setMethod] = useState<'balance' | 'cash'>('balance');
  const unitCost = Math.round(b.unit_cost ?? 0);
  const over = q !== null && q > b.qty;
  return (
    <Modal title={`إرجاع للمورد — ${b.name}`} onClose={onClose} footer={<button className="btn primary" disabled={busy || !q || over || !supplierId} onClick={() => run(async () => {
      await api('purchases.return', { supplierId, locationId: b.location_id, refundMethod: method, reason, lines: [{ batchId: b.batch_id, productId: b.product_id, unitId: b.base_unit_id, qty: q, unitCost }] });
      onClose();
    }, 'تم تسجيل المرتجع للمورد')}>تسجيل المرتجع</button>}>
      <div className="col">
        <div className="alert info small">الدفعة #{b.batch_id}{b.batch_no ? ` (${b.batch_no})` : ''} — صلاحية {dateOnly(b.expiry_date)} — المتاح في الدفعة {qty(b.qty)} {b.unit_symbol}. سيُخصم من هذه الدفعة فقط.</div>
        <Field label="المورد">
          <select className="select" value={supplierId} disabled={!!b.supplier_id} onChange={(e) => setSupplierId(Number(e.target.value) || '')}>
            <option value="">اختر المورد</option>
            {(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={`الكمية (${b.unit_symbol})`} error={over ? 'أكبر من كمية الدفعة' : undefined}><QtyInput value={q} onChange={setQ} /></Field>
        <Field label="سبب المرتجع"><select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>{RETURN_REASONS.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="طريقة التسوية"><Segmented value={method} onChange={setMethod} options={[{ value: 'balance', label: 'خصم من حساب المورد' }, { value: 'cash', label: 'استرداد نقدي' }]} /></Field>
        {q !== null && !over && <div className="small muted">قيمة المرتجع بسعر الشراء: {money(Math.round((unitCost * q) / 1000))}</div>}
      </div>
    </Modal>
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

