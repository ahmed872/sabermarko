import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Package, Plus, Trash2, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { money, qty as fmtQty } from '../lib/format';
import { Field, Loading, MoneyInput, NumberInput, PageHeader, QtyInput, Segmented, Switch, useAction, useToast } from '../components/ui';
import { readImageFile } from './Auth';

interface UnitRow { unitId: number; factor: number | null; barcode: string; sellPrice: number | null; isDefaultSale: boolean; isDefaultPurchase: boolean }
type SellMode = 'count' | 'weight' | 'volume';
/** The pack the shop buys and shelves the product in (carton, dozen…), holding `count` of the unit it sells. */
interface Pack { on: boolean; unitId: number; count: number | null; barcode: string; sellPrice: number | null }
const NO_PACK: Pack = { on: false, unitId: 0, count: null, barcode: '', sellPrice: null };

export default function ProductForm() {
  const { id } = useParams();
  const editId = id ? Number(id) : null;
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can, feature } = useApp();
  const toast = useToast();
  const { run, busy } = useAction();
  const units = useQuery({ queryKey: ['units'], queryFn: () => api<any[]>('units.list') });
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('categories.list') });
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api<any[]>('brands.list') });
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => api<any[]>('groups.list') });
  const suppliers = useQuery({ queryKey: ['suppliers', 'pick'], queryFn: () => api<any[]>('suppliers.list', {}), enabled: can('purchases.view') });
  const priceLists = useQuery({ queryKey: ['priceLists'], queryFn: () => api<any[]>('priceLists.list'), enabled: feature('priceLists') });
  const existing = useQuery({ queryKey: ['product', editId], queryFn: () => api('products.get', { id: editId }), enabled: !!editId });

  const [f, setF] = useState({
    name: '', shortName: '', categoryId: '' as number | '', brandName: '', groupName: '', variantName: '', baseUnitId: 0, sku: '', barcode: '',
    sellPrice: null as number | null, cost: null as number | null, minStock: 0 as number | null, reorderQty: null as number | null, isWeighted: false,
    trackExpiry: false, taxRate: null as number | null, defaultSupplierId: '' as number | '', isFavorite: false, allowDiscount: true, image: '', notes: '', active: true,
    openingQty: null as number | null, openingExpiry: '',
  });
  const [unitRows, setUnitRows] = useState<UnitRow[]>([]); // other units (beyond the pack)
  const [pack, setPack] = useState<Pack>(NO_PACK);
  const [openingPacks, setOpeningPacks] = useState<number | null>(null);
  const setP = <K extends keyof Pack>(k: K, v: Pack[K]) => setPack((x) => ({ ...x, [k]: v }));
  const [prices, setPrices] = useState<Record<number, number | null>>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [advanced, setAdvanced] = useState(false);

  const piece = units.data?.find((u) => u.name === 'قطعة');
  useEffect(() => { if (!editId && units.data && !f.baseUnitId && piece) set('baseUnitId', piece.id); }, [units.data, editId, f.baseUnitId, piece]);
  useEffect(() => {
    const p = existing.data;
    if (!p || !units.data) return;
    setF({
      name: p.name, shortName: p.short_name ?? '', categoryId: p.category_id ?? '', brandName: p.brand_name ?? '', groupName: p.group_name ?? '', variantName: p.variant_name ?? '',
      baseUnitId: p.base_unit_id, sku: p.sku ?? '', barcode: p.barcode ?? '', sellPrice: p.sell_price, cost: p.avg_cost === null ? null : Math.round(p.avg_cost * 100) / 100,
      minStock: p.min_stock, reorderQty: p.reorder_qty, isWeighted: !!p.is_weighted, trackExpiry: !!p.track_expiry, taxRate: p.tax_rate, defaultSupplierId: p.default_supplier_id ?? '',
      isFavorite: !!p.is_favorite, allowDiscount: !!p.allow_discount, image: p.image ?? '', notes: p.notes ?? '', active: !!p.active, openingQty: null, openingExpiry: '',
    });
    const rows: UnitRow[] = p.units.filter((u: any) => u.unit_id !== p.base_unit_id).map((u: any) => ({ unitId: u.unit_id, factor: u.factor, barcode: u.barcode ?? '', sellPrice: u.sell_price, isDefaultSale: !!u.is_default_sale, isDefaultPurchase: !!u.is_default_purchase }));
    // the pack: the purchase unit (or the biggest whole-count unit) that holds a whole number of the base unit
    const isPack = (r: UnitRow) => r.factor! > 1000 && r.factor! % 1000 === 0 && units.data!.find((u) => u.id === r.unitId)?.kind === 'count';
    const pk = [...rows].sort((a, b) => Number(b.isDefaultPurchase) - Number(a.isDefaultPurchase) || b.factor! - a.factor!).find(isPack);
    setPack(pk ? { on: true, unitId: pk.unitId, count: pk.factor! / 1000, barcode: pk.barcode, sellPrice: pk.sellPrice } : NO_PACK);
    setUnitRows(rows.filter((r) => r !== pk));
    setPrices(Object.fromEntries(p.prices.map((x: any) => [x.price_list_id, x.price])));
    if (rows.length > (pk ? 1 : 0) || p.group_name || p.brand_name || p.sku) setAdvanced(true);
  }, [existing.data, units.data]);

  const unitOpts = (units.data ?? []).filter((u) => u.active);
  const countUnits = unitOpts.filter((u) => u.kind === 'count');
  const base = units.data?.find((u) => u.id === f.baseUnitId);
  const mode: SellMode = base?.kind === 'weight' ? 'weight' : base?.kind === 'volume' ? 'volume' : 'count';
  const packUnit = units.data?.find((u) => u.id === pack.unitId);
  const packFactor = pack.on && pack.count && pack.count > 0 ? Math.round(pack.count * 1000) : null;
  const byName = (n: string) => units.data?.find((u) => u.name === n);

  /** Switching how the product is sold resets everything that only made sense for the old way (the old bug: a
   *  product switched from kilo to pieces stayed "sold by weight" and asked for grams at every sale). */
  const chooseMode = (m: SellMode) => {
    if (m === mode) return;
    const nb = m === 'weight' ? byName('كيلو') : m === 'volume' ? byName('لتر') : piece;
    if (!nb) return;
    const sub = m === 'weight' ? byName('جرام') : m === 'volume' ? byName('ملليلتر') : null;
    setF((x) => ({ ...x, baseUnitId: nb.id, isWeighted: m !== 'count' }));
    setUnitRows((r) => {
      const keep = r.filter((u) => units.data?.find((x) => x.id === u.unitId)?.kind === 'count');
      return sub ? [...keep, { unitId: sub.id, factor: 1, barcode: '', sellPrice: null, isDefaultSale: false, isDefaultPurchase: false }] : keep;
    });
    if (m !== 'count') setPack(NO_PACK);
  };
  const turnPackOn = (on: boolean) => {
    if (!on) { setPack(NO_PACK); return; }
    const first = byName('كرتونة') ?? countUnits.find((u) => u.id !== f.baseUnitId);
    setPack({ ...NO_PACK, on: true, unitId: first?.id ?? 0 });
  };

  const margin = useMemo(() => {
    if (!f.sellPrice || f.cost === null || f.cost === undefined || !can('reports.cost')) return null;
    const m = f.sellPrice - f.cost;
    return { amount: m, pct: f.sellPrice > 0 ? (m / f.sellPrice) * 100 : 0 };
  }, [f.sellPrice, f.cost, can]);

  const submit = (another = false) => run(async () => {
    if (!f.name.trim()) throw new Error('اسم المنتج مطلوب');
    if (f.sellPrice === null) throw new Error('سعر البيع مطلوب');
    if (pack.on && !packFactor) throw new Error(`اكتب كام ${base?.name ?? 'قطعة'} في ال${packUnit?.name ?? 'كرتونة'}`);
    if (pack.on && pack.unitId === f.baseUnitId) throw new Error('وحدة الجملة لازم تكون غير وحدة البيع');
    const packRow = pack.on && packFactor ? [{ unitId: pack.unitId, factor: packFactor, barcode: pack.barcode || null, sellPrice: pack.sellPrice, isDefaultSale: false, isDefaultPurchase: true }] : [];
    const otherRows = unitRows.filter((u) => u.unitId && u.factor && u.factor > 0 && u.unitId !== pack.unitId)
      .map((u) => ({ unitId: u.unitId, factor: u.factor!, barcode: u.barcode || null, sellPrice: u.sellPrice, isDefaultSale: u.isDefaultSale, isDefaultPurchase: packRow.length ? false : u.isDefaultPurchase }));
    const openingTotal = (openingPacks && packFactor ? openingPacks * packFactor : 0) + (f.openingQty ?? 0); // milli of the base unit
    const data = {
      name: f.name, shortName: f.shortName || null, categoryId: f.categoryId || null, brandName: f.brandName || null, groupName: f.groupName || null,
      variantName: f.variantName || null, baseUnitId: f.baseUnitId, sku: f.sku || null, barcode: f.barcode || null, sellPrice: f.sellPrice,
      ...(f.cost !== null && (can('products.edit_cost') || !editId) ? { cost: f.cost } : {}),
      minStock: f.minStock ?? 0, reorderQty: f.reorderQty, isWeighted: f.isWeighted, trackExpiry: f.trackExpiry, taxRate: f.taxRate,
      defaultSupplierId: f.defaultSupplierId || null, isFavorite: f.isFavorite, allowDiscount: f.allowDiscount, image: f.image || null, notes: f.notes || null, active: f.active,
      units: [...packRow, ...otherRows],
      prices: Object.entries(prices).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => ({ priceListId: Number(k), price: v! })),
      openingStock: !editId && openingTotal > 0 ? { qty: Math.round(openingTotal), unitCost: f.cost ?? 0, expiryDate: f.openingExpiry || null } : null,
    };
    const res = editId ? await api('products.update', { id: editId, data }) : await api('products.create', data);
    await qc.invalidateQueries({ queryKey: ['products'] });
    await qc.invalidateQueries({ queryKey: ['product'] });
    await qc.invalidateQueries({ queryKey: ['pos-browse'] });
    toast(editId ? 'تم حفظ التعديلات' : 'تمت إضافة المنتج', 'success');
    if (another) {
      setF((x) => ({ ...x, name: '', shortName: '', variantName: '', sku: '', barcode: '', sellPrice: null, cost: null, openingQty: null, openingExpiry: '' }));
      setUnitRows((r) => r.map((u) => ({ ...u, barcode: '' })));
      setPack((x) => ({ ...x, barcode: '', sellPrice: null }));
      setOpeningPacks(null);
      document.getElementById('pname')?.focus();
    } else nav(`/products/${res.id}`, { replace: true });
  });

  if (editId && existing.isLoading) return <Loading />;
  return (
    <div style={{ maxWidth: 1000 }}>
      <PageHeader title={editId ? `تعديل: ${existing.data?.name ?? ''}` : 'منتج جديد'} icon={<Package color="var(--primary)" />}
        actions={<button className="btn" onClick={() => nav(-1)}><X size={16} /> إلغاء</button>} />
      <form className="col gap-lg" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
        <div className="card pad">
          <div className="section-title">البيانات الأساسية</div>
          <div className="form-grid">
            <Field label="اسم المنتج *" className="span-2"><input id="pname" className="input lg" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="مثال: بيبسي كانز 330 مل" /></Field>
            <Field label="التصنيف">
              <select id="p-category" className="select" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : '')}>
                <option value="">بدون تصنيف</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label={`باركود ال${base?.name ?? 'قطعة'}`} help="اختياري — امسحه بالقارئ هنا"><input id="p-barcode" className="input num-input" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} /></Field>
            <Field label="الكود الداخلي (SKU)" help="اختياري — كود قصير للبحث السريع"><input className="input num-input" value={f.sku} onChange={(e) => set('sku', e.target.value)} /></Field>
            <div className="field"><label>منتج سريع في شاشة البيع</label><div className="row" style={{ height: 38 }}><Switch checked={f.isFavorite} onChange={(v) => set('isFavorite', v)} /><span className="small muted">يظهر في "المنتجات السريعة"</span></div></div>
          </div>
        </div>

        <div className="card pad" id="p-selling">
          <div className="section-title">بيتباع إزاي؟</div>
          <div className="col gap-lg">
            <Segmented value={mode} onChange={chooseMode} options={[
              { value: 'count', label: 'بالعدد (قطعة، كيس، كانز…)' },
              { value: 'weight', label: 'بالوزن (كيلو)' },
              { value: 'volume', label: 'باللتر' },
            ]} />
            {editId && <div className="small muted">لا يمكن تغيير طريقة البيع أو وحدة البيع بعد وجود حركات مخزون للمنتج.</div>}
            <div className="form-grid">
              {mode === 'count' ? (
                <Field label="الزبون بياخد منه" help="أصغر حاجة بتبيعها — كل الكميات والأسعار بتتحسب بيها">
                  <select id="p-base-unit" className="select" value={f.baseUnitId} onChange={(e) => { const v = Number(e.target.value); set('baseUnitId', v); if (pack.unitId === v) setPack(NO_PACK); }}>
                    {countUnits.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </Field>
              ) : (
                <div className="field"><label>وحدة البيع</label><div className="alert info small" style={{ minHeight: 38, alignItems: 'center' }}>بال{base?.name} — البرنامج يطلب {mode === 'weight' ? 'الوزن' : 'الكمية'} أو المبلغ عند البيع</div></div>
              )}
              {mode === 'count' && (
                <div className="field span-2">
                  <label>بتشتريه أو بترصّه في كرتونة / دستة / علبة؟</label>
                  <div className="row" style={{ minHeight: 38 }}>
                    <Switch checked={pack.on} onChange={turnPackOn} label="له وحدة جملة" />
                    {!pack.on && <span className="small muted">لا — بشتريه بال{base?.name ?? 'قطعة'}</span>}
                    {pack.on && (
                      <div className="row wrap" style={{ gap: 8 }}>
                        <span>أيوه، في</span>
                        <select id="p-pack-unit" className="select" style={{ width: 'auto' }} value={pack.unitId} onChange={(e) => setP('unitId', Number(e.target.value))}>
                          {countUnits.filter((u) => u.id !== f.baseUnitId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                        <span>فيها</span>
                        <div style={{ width: 90 }}><NumberInput id="p-pack-count" value={pack.count} allowEmpty onChange={(v) => setP('count', v === null ? null : Math.max(0, Math.floor(v)))} placeholder="12" /></div>
                        <span>{base?.name ?? 'قطعة'}</span>
                      </div>
                    )}
                  </div>
                  {pack.on && packFactor && <div className="small mt"><b>1 {packUnit?.name} = {pack.count} {base?.name}</b> — الشراء والجرد بال{packUnit?.name}، والبيع للزبون بال{base?.name} مباشرة من غير أي سؤال.</div>}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card pad">
          <div className="section-title">الأسعار والكمية</div>
          <div className="form-grid">
            <Field label={`سعر بيع ال${base?.name ?? 'قطعة'} *`}><MoneyInput id="p-price" className="lg" value={f.sellPrice} onChange={(v) => set('sellPrice', v)} allowEmpty disabled={!!editId && !can('products.edit_price')} /></Field>
            {(can('products.edit_cost') || !editId) && (pack.on && packFactor ? (
              <Field label={`سعر شراء ال${packUnit?.name}`} help={f.cost !== null ? `يعني تكلفة ال${base?.name}: ${money(Math.round(f.cost))}` : `البرنامج يقسمه على ${pack.count} لوحده`}>
                <MoneyInput id="p-cost" value={f.cost === null ? null : Math.round((f.cost * packFactor) / 1000)} allowEmpty onChange={(v) => set('cost', v === null ? null : (v * 1000) / packFactor)} />
              </Field>
            ) : (
              <Field label={`سعر شراء ال${base?.name ?? 'قطعة'}`} help={editId ? 'يتغير تلقائيًا مع المشتريات (متوسط التكلفة)' : 'يُستخدم لحساب الربح'}>
                <MoneyInput id="p-cost" value={f.cost} onChange={(v) => set('cost', v)} allowEmpty />
              </Field>
            ))}
            {margin && <div className="field"><label>ربح ال{base?.name}</label><div className={`alert ${margin.amount < 0 ? 'danger' : 'success'}`} style={{ height: 38, alignItems: 'center' }}>{money(Math.round(margin.amount))} ({margin.pct.toFixed(1)}%)</div></div>}
            {pack.on && packFactor && (
              <Field label={`سعر بيع ال${packUnit?.name} كاملة (جملة)`} help={f.sellPrice ? `اختياري — لو سبته فاضي: ${money(Math.round((f.sellPrice * packFactor) / 1000))}` : 'اختياري'}>
                <MoneyInput id="p-pack-price" value={pack.sellPrice} allowEmpty onChange={(v) => setP('sellPrice', v)} />
              </Field>
            )}
            {pack.on && packFactor && pack.sellPrice !== null && f.sellPrice !== null && (() => {
              const asPieces = Math.round((f.sellPrice * packFactor) / 1000);
              const packCost = f.cost !== null ? Math.round((f.cost * packFactor) / 1000) : null;
              if (packCost !== null && pack.sellPrice < packCost) return <div className="alert danger small span-2">سعر ال{packUnit?.name} ({money(pack.sellPrice)}) أقل من تكلفتها ({money(packCost)}) — هتبيع بخسارة.</div>;
              if (pack.sellPrice > asPieces) return <div className="alert warning small span-2">سعر ال{packUnit?.name} ({money(pack.sellPrice)}) أغلى من {pack.count} {base?.name} بالقطعة ({money(asPieces)}) — الزبون هيوفر لو اشترى بالقطعة.</div>;
              return null;
            })()}
            {pack.on && packFactor && <Field label={`باركود ال${packUnit?.name}`} help="اختياري — مسحه في البيع يضيف الكرتونة كاملة"><input id="p-pack-barcode" className="input num-input" value={pack.barcode} onChange={(e) => setP('barcode', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} /></Field>}
            {!editId && (pack.on && packFactor ? (
              <div className="field span-2">
                <label>الموجود عندك دلوقتي</label>
                <div className="row wrap" style={{ gap: 8 }}>
                  <div style={{ width: 110 }}><NumberInput id="p-opening-packs" value={openingPacks} allowEmpty onChange={(v) => setOpeningPacks(v === null ? null : Math.max(0, Math.floor(v)))} placeholder="0" /></div><span>{packUnit?.name}</span>
                  <span>+</span>
                  <div style={{ width: 110 }}><QtyInput id="p-opening" value={f.openingQty} allowEmpty onChange={(v) => set('openingQty', v)} placeholder="0" /></div><span>{base?.name} فرط</span>
                  {((openingPacks ?? 0) > 0 || (f.openingQty ?? 0) > 0) && <span className="small muted">= {fmtQty(((openingPacks ?? 0) * packFactor) + (f.openingQty ?? 0))} {base?.name}</span>}
                </div>
                <div className="help">رصيد افتتاحي — يُسجل كحركة مخزون</div>
              </div>
            ) : (
              <Field label="الكمية الموجودة الآن" help="رصيد افتتاحي — يُسجل كحركة مخزون"><QtyInput id="p-opening" value={f.openingQty} onChange={(v) => set('openingQty', v)} allowEmpty suffix={base?.symbol} /></Field>
            ))}
            {!editId && feature('expiry') && f.trackExpiry && <Field label="تاريخ صلاحية الكمية الحالية"><input type="date" className="input" value={f.openingExpiry} onChange={(e) => set('openingExpiry', e.target.value)} /></Field>}
            <Field label={`الحد الأدنى للمخزون (${base?.name ?? ''})`} help={pack.on && packFactor && f.minStock ? `= ${fmtQty(Math.round(((f.minStock ?? 0) * 1000) / packFactor))} ${packUnit?.name}` : 'ينبهك البرنامج عند الوصول إليه'}><QtyInput value={f.minStock} onChange={(v) => set('minStock', v)} suffix={base?.symbol} /></Field>
            {feature('expiry') && <div className="field"><label>له تاريخ صلاحية؟</label><div className="row" style={{ height: 38 }}><Switch checked={f.trackExpiry} onChange={(v) => set('trackExpiry', v)} /><span className="small muted">يُطلب التاريخ عند الشراء ويُباع الأقرب انتهاءً أولًا</span></div></div>}
          </div>
        </div>

        <details className="card pad adv" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>خيارات متقدمة: وحدات أخرى، الأحجام، البراند، أسعار الجملة</summary>
          <div className="col gap-lg mt">
            <div>
              <div className="section-title">وحدات أخرى</div>
              <p className="small muted">نادرًا ما تحتاجها: مثلًا لو بتبيع نفس الشيبسي بالكيس وبالدستة وبالكرتونة. الوحدة الأساسية للجملة مكتوبة فوق في «بيتباع إزاي؟».</p>
              <div className="unit-rows">
                {unitRows.map((u, i) => (
                  <div key={i} className="unit-row">
                    <Field label="الوحدة">
                      <select className="select" value={u.unitId} onChange={(e) => setUnitRows((r) => r.map((x, j) => (j === i ? { ...x, unitId: Number(e.target.value) } : x)))}>
                        {unitOpts.filter((x) => x.id !== f.baseUnitId && x.id !== pack.unitId && (mode !== 'count' || x.kind === 'count')).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    </Field>
                    <Field label={`تحتوي على (${base?.symbol ?? ''})`}><QtyInput value={u.factor} onChange={(v) => setUnitRows((r) => r.map((x, j) => (j === i ? { ...x, factor: v } : x)))} /></Field>
                    <Field label="سعر بيعها (اختياري)" help={u.factor && f.sellPrice ? `تلقائي: ${money(Math.round((f.sellPrice * u.factor) / 1000))}` : undefined}>
                      <MoneyInput value={u.sellPrice} allowEmpty onChange={(v) => setUnitRows((r) => r.map((x, j) => (j === i ? { ...x, sellPrice: v } : x)))} />
                    </Field>
                    <Field label="باركود الوحدة"><input className="input num-input" value={u.barcode} onChange={(e) => setUnitRows((r) => r.map((x, j) => (j === i ? { ...x, barcode: e.target.value } : x)))} /></Field>
                    <div className="col gap-sm">
                      <label className="check xs"><input type="checkbox" checked={u.isDefaultPurchase} onChange={(e) => setUnitRows((r) => r.map((x, j) => ({ ...x, isDefaultPurchase: j === i ? e.target.checked : false })))} /> وحدة الشراء</label>
                      <label className="check xs"><input type="checkbox" checked={u.isDefaultSale} onChange={(e) => setUnitRows((r) => r.map((x, j) => ({ ...x, isDefaultSale: j === i ? e.target.checked : false })))} /> وحدة البيع</label>
                      <button type="button" className="btn ghost sm" onClick={() => setUnitRows((r) => r.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                    </div>
                  </div>
                ))}
              </div>
              <button type="button" className="btn sm" onClick={() => { const c = countUnits.find((x) => x.id !== f.baseUnitId && x.id !== pack.unitId && !unitRows.some((r) => r.unitId === x.id)); if (c) setUnitRows((r) => [...r, { unitId: c.id, factor: null, barcode: '', sellPrice: null, isDefaultSale: false, isDefaultPurchase: false }]); }}><Plus size={14} /> إضافة وحدة</button>
              {unitRows.some((u) => u.factor) && <div className="small muted mt">{unitRows.filter((u) => u.factor).map((u) => `1 ${unitOpts.find((x) => x.id === u.unitId)?.name} = ${fmtQty(u.factor)} ${base?.name}`).join(' • ')}</div>}
            </div>
            <div className="form-grid">
              <Field label="المنتج الرئيسي (للأحجام/الأنواع)" help="مثال: كوكاكولا — ثم الحجم في الحقل التالي">
                <input className="input" list="groups" value={f.groupName} onChange={(e) => set('groupName', e.target.value)} />
                <datalist id="groups">{(groups.data ?? []).map((g) => <option key={g.id} value={g.name} />)}</datalist>
              </Field>
              <Field label="الحجم / النوع" help="مثال: 330 مل، 1 لتر"><input className="input" value={f.variantName} onChange={(e) => set('variantName', e.target.value)} /></Field>
              <Field label="البراند"><input className="input" list="brands" value={f.brandName} onChange={(e) => set('brandName', e.target.value)} /><datalist id="brands">{(brands.data ?? []).map((b) => <option key={b.id} value={b.name} />)}</datalist></Field>
              <Field label="الاسم المختصر" help="يظهر في البحث"><input className="input" value={f.shortName} onChange={(e) => set('shortName', e.target.value)} /></Field>
              {can('purchases.view') && (
                <Field label="المورد الافتراضي">
                  <select className="select" value={f.defaultSupplierId} onChange={(e) => set('defaultSupplierId', e.target.value ? Number(e.target.value) : '')}>
                    <option value="">—</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
              )}
              <Field label="كمية إعادة الطلب" help="الكمية المعتادة عند الطلب من المورد"><QtyInput value={f.reorderQty} allowEmpty onChange={(v) => set('reorderQty', v)} suffix={base?.symbol} /></Field>
              {feature('tax') && <Field label="نسبة الضريبة %" help="اتركها فارغة لاستخدام نسبة المحل"><NumberInput value={f.taxRate} allowEmpty onChange={(v) => set('taxRate', v)} /></Field>}
              {feature('priceLists') && (priceLists.data ?? []).filter((pl) => !pl.is_default).map((pl) => (
                <Field key={pl.id} label={`${pl.name} (لكل ${base?.name ?? ''})`}><MoneyInput value={prices[pl.id] ?? null} allowEmpty onChange={(v) => setPrices((p) => ({ ...p, [pl.id]: v }))} /></Field>
              ))}
            </div>
            <div className="col">
              {mode === 'volume' && <label className="check"><input type="checkbox" checked={f.isWeighted} onChange={(e) => set('isWeighted', e.target.checked)} /> يطلب الكمية (لتر/مل) أو المبلغ عند كل بيعة</label>}
              <label className="check"><input type="checkbox" checked={f.allowDiscount} onChange={(e) => set('allowDiscount', e.target.checked)} /> يقبل الخصم</label>
              {editId && <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /> المنتج نشط (يظهر في البيع)</label>}
            </div>
            <div className="row top gap-lg">
              <Field label="صورة المنتج (اختياري)">
                <div className="row">
                  {f.image && <img src={f.image} alt="" style={{ width: 64, height: 64, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 8 }} />}
                  <label className="btn sm"><Upload size={14} /> اختيار صورة<input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={async (e) => { const file = e.target.files?.[0]; if (file) { try { set('image', await readImageFile(file, 256)); } catch (err) { toast((err as Error).message, 'error'); } } }} /></label>
                  {f.image && <button type="button" className="btn ghost sm" onClick={() => set('image', '')}>إزالة</button>}
                </div>
              </Field>
              <Field label="ملاحظات" className="grow"><textarea className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
            </div>
          </div>
        </details>

        <div className="row">
          <button className="btn primary lg" disabled={busy}>حفظ</button>
          {!editId && <button type="button" className="btn lg" disabled={busy} onClick={() => void submit(true)}>حفظ وإضافة منتج آخر</button>}
          <button type="button" className="btn lg ghost" onClick={() => nav(-1)}>إلغاء</button>
        </div>
      </form>
    </div>
  );
}
