import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Package, Plus, Trash2, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { money, qty as fmtQty } from '../lib/format';
import { Field, Loading, MoneyInput, NumberInput, PageHeader, QtyInput, Switch, useAction, useToast } from '../components/ui';
import { readImageFile } from './Auth';

interface UnitRow { unitId: number; factor: number | null; barcode: string; sellPrice: number | null; isDefaultSale: boolean; isDefaultPurchase: boolean }

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
  const [unitRows, setUnitRows] = useState<UnitRow[]>([]);
  const [prices, setPrices] = useState<Record<number, number | null>>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [advanced, setAdvanced] = useState(false);

  const piece = units.data?.find((u) => u.name === 'قطعة');
  useEffect(() => { if (!editId && units.data && !f.baseUnitId && piece) set('baseUnitId', piece.id); }, [units.data, editId, f.baseUnitId, piece]);
  useEffect(() => {
    const p = existing.data;
    if (!p) return;
    setF({
      name: p.name, shortName: p.short_name ?? '', categoryId: p.category_id ?? '', brandName: p.brand_name ?? '', groupName: p.group_name ?? '', variantName: p.variant_name ?? '',
      baseUnitId: p.base_unit_id, sku: p.sku ?? '', barcode: p.barcode ?? '', sellPrice: p.sell_price, cost: p.avg_cost === null ? null : Math.round(p.avg_cost * 100) / 100,
      minStock: p.min_stock, reorderQty: p.reorder_qty, isWeighted: !!p.is_weighted, trackExpiry: !!p.track_expiry, taxRate: p.tax_rate, defaultSupplierId: p.default_supplier_id ?? '',
      isFavorite: !!p.is_favorite, allowDiscount: !!p.allow_discount, image: p.image ?? '', notes: p.notes ?? '', active: !!p.active, openingQty: null, openingExpiry: '',
    });
    setUnitRows(p.units.filter((u: any) => u.unit_id !== p.base_unit_id).map((u: any) => ({ unitId: u.unit_id, factor: u.factor, barcode: u.barcode ?? '', sellPrice: u.sell_price, isDefaultSale: !!u.is_default_sale, isDefaultPurchase: !!u.is_default_purchase })));
    setPrices(Object.fromEntries(p.prices.map((x: any) => [x.price_list_id, x.price])));
    if (p.units.length > 1 || p.group_name || p.brand_name || p.sku) setAdvanced(true);
  }, [existing.data]);

  const base = units.data?.find((u) => u.id === f.baseUnitId);
  const gram = units.data?.find((u) => u.name === 'جرام');
  const ml = units.data?.find((u) => u.name === 'ملليلتر');
  // a product sold by kilo automatically gets a gram sub-unit (and litre -> ml) so cashiers can type grams
  useEffect(() => {
    if (!base || editId) return;
    const sub = base.name === 'كيلو' ? gram : base.name === 'لتر' ? ml : null;
    if (base.kind === 'weight') set('isWeighted', true);
    if (sub && !unitRows.some((r) => r.unitId === sub.id)) setUnitRows((r) => [...r, { unitId: sub.id, factor: 1, barcode: '', sellPrice: null, isDefaultSale: false, isDefaultPurchase: false }]);
  }, [base?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const margin = useMemo(() => {
    if (!f.sellPrice || f.cost === null || f.cost === undefined || !can('reports.cost')) return null;
    const m = f.sellPrice - f.cost;
    return { amount: m, pct: f.sellPrice > 0 ? (m / f.sellPrice) * 100 : 0 };
  }, [f.sellPrice, f.cost, can]);

  const submit = (another = false) => run(async () => {
    if (!f.name.trim()) throw new Error('اسم المنتج مطلوب');
    if (f.sellPrice === null) throw new Error('سعر البيع مطلوب');
    const data = {
      name: f.name, shortName: f.shortName || null, categoryId: f.categoryId || null, brandName: f.brandName || null, groupName: f.groupName || null,
      variantName: f.variantName || null, baseUnitId: f.baseUnitId, sku: f.sku || null, barcode: f.barcode || null, sellPrice: f.sellPrice,
      ...(f.cost !== null && (can('products.edit_cost') || !editId) ? { cost: f.cost } : {}),
      minStock: f.minStock ?? 0, reorderQty: f.reorderQty, isWeighted: f.isWeighted, trackExpiry: f.trackExpiry, taxRate: f.taxRate,
      defaultSupplierId: f.defaultSupplierId || null, isFavorite: f.isFavorite, allowDiscount: f.allowDiscount, image: f.image || null, notes: f.notes || null, active: f.active,
      units: unitRows.filter((u) => u.unitId && u.factor && u.factor > 0).map((u) => ({ unitId: u.unitId, factor: u.factor!, barcode: u.barcode || null, sellPrice: u.sellPrice, isDefaultSale: u.isDefaultSale, isDefaultPurchase: u.isDefaultPurchase })),
      prices: Object.entries(prices).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => ({ priceListId: Number(k), price: v! })),
      openingStock: !editId && f.openingQty && f.openingQty > 0 ? { qty: f.openingQty, unitCost: f.cost ?? 0, expiryDate: f.openingExpiry || null } : null,
    };
    const res = editId ? await api('products.update', { id: editId, data }) : await api('products.create', data);
    await qc.invalidateQueries({ queryKey: ['products'] });
    await qc.invalidateQueries({ queryKey: ['product'] });
    await qc.invalidateQueries({ queryKey: ['pos-browse'] });
    toast(editId ? 'تم حفظ التعديلات' : 'تمت إضافة المنتج', 'success');
    if (another) {
      setF((x) => ({ ...x, name: '', shortName: '', variantName: '', sku: '', barcode: '', sellPrice: null, cost: null, openingQty: null, openingExpiry: '' }));
      setUnitRows((r) => r.map((u) => ({ ...u, barcode: '' })));
      document.getElementById('pname')?.focus();
    } else nav(`/products/${res.id}`, { replace: true });
  });

  if (editId && existing.isLoading) return <Loading />;
  const unitOpts = (units.data ?? []).filter((u) => u.active);
  return (
    <div style={{ maxWidth: 1000 }}>
      <PageHeader title={editId ? `تعديل: ${existing.data?.name ?? ''}` : 'منتج جديد'} icon={<Package color="var(--primary)" />}
        actions={<button className="btn" onClick={() => nav(-1)}><X size={16} /> إلغاء</button>} />
      <form className="col gap-lg" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
        <div className="card pad">
          <div className="section-title">البيانات الأساسية</div>
          <div className="form-grid">
            <Field label="اسم المنتج *" className="span-2"><input id="pname" className="input lg" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="مثال: شيبسي طماطم كبير" /></Field>
            <Field label="التصنيف">
              <select className="select" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : '')}>
                <option value="">بدون تصنيف</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="الوحدة الأساسية (وحدة المخزون والبيع)" help={editId ? 'لا يمكن تغييرها بعد وجود حركات' : 'للمنتجات بالوزن اختر "كيلو"'}>
              <select className="select" value={f.baseUnitId} onChange={(e) => set('baseUnitId', Number(e.target.value))}>
                {unitOpts.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
            <Field label={`سعر البيع * ${base ? `(لكل ${base.name})` : ''}`}><MoneyInput className="lg" value={f.sellPrice} onChange={(v) => set('sellPrice', v)} allowEmpty disabled={!!editId && !can('products.edit_price')} /></Field>
            {(can('products.edit_cost') || !editId) && (
              <Field label={`سعر الشراء / التكلفة ${base ? `(لكل ${base.name})` : ''}`} help={editId ? 'يتغير تلقائيًا مع المشتريات (متوسط التكلفة)' : 'يُستخدم لحساب الربح'}>
                <MoneyInput value={f.cost} onChange={(v) => set('cost', v)} allowEmpty />
              </Field>
            )}
            {margin && <div className="field"><label>هامش الربح</label><div className={`alert ${margin.amount < 0 ? 'danger' : 'success'}`} style={{ height: 38, alignItems: 'center' }}>{money(margin.amount)} ({margin.pct.toFixed(1)}%)</div></div>}
            <Field label="الباركود" help="اختياري — يمكن مسحه بالقارئ هنا"><input className="input num-input" value={f.barcode} onChange={(e) => set('barcode', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }} /></Field>
            <Field label="الكود الداخلي (SKU)" help="اختياري — كود قصير للبحث السريع"><input className="input num-input" value={f.sku} onChange={(e) => set('sku', e.target.value)} /></Field>
            {!editId && <Field label="الكمية الموجودة الآن" help="رصيد افتتاحي — يُسجل كحركة مخزون"><QtyInput value={f.openingQty} onChange={(v) => set('openingQty', v)} allowEmpty suffix={base?.symbol} /></Field>}
            {!editId && feature('expiry') && f.trackExpiry && <Field label="تاريخ صلاحية الكمية الحالية"><input type="date" className="input" value={f.openingExpiry} onChange={(e) => set('openingExpiry', e.target.value)} /></Field>}
            <Field label="الحد الأدنى للمخزون" help="ينبهك البرنامج عند الوصول إليه"><QtyInput value={f.minStock} onChange={(v) => set('minStock', v)} suffix={base?.symbol} /></Field>
            <div className="field"><label>منتج سريع في شاشة البيع</label><div className="row" style={{ height: 38 }}><Switch checked={f.isFavorite} onChange={(v) => set('isFavorite', v)} /><span className="small muted">يظهر في "المنتجات السريعة"</span></div></div>
          </div>
        </div>

        <details className="card pad adv" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>خيارات متقدمة: الكرتونة والوحدات، الأحجام، البراند، الصلاحية، أسعار الجملة</summary>
          <div className="col gap-lg mt">
            <div>
              <div className="section-title">وحدات إضافية (كرتونة، علبة، دستة…)</div>
              <p className="small muted">مثال: كرتونة شيبسي = 30 {base?.name ?? 'قطعة'}. عند شراء 2 كرتونة يزيد المخزون 60 {base?.name ?? 'قطعة'} تلقائيًا.</p>
              <div className="unit-rows">
                {unitRows.map((u, i) => (
                  <div key={i} className="unit-row">
                    <Field label="الوحدة">
                      <select className="select" value={u.unitId} onChange={(e) => setUnitRows((r) => r.map((x, j) => (j === i ? { ...x, unitId: Number(e.target.value) } : x)))}>
                        {unitOpts.filter((x) => x.id !== f.baseUnitId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
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
              <button type="button" className="btn sm" onClick={() => { const c = unitOpts.find((x) => x.name === 'كرتونة') ?? unitOpts.find((x) => x.id !== f.baseUnitId); if (c) setUnitRows((r) => [...r, { unitId: c.id, factor: null, barcode: '', sellPrice: null, isDefaultSale: false, isDefaultPurchase: r.length === 0 }]); }}><Plus size={14} /> إضافة وحدة</button>
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
              {feature('expiry') && <label className="check"><input type="checkbox" checked={f.trackExpiry} onChange={(e) => set('trackExpiry', e.target.checked)} /> له تاريخ صلاحية (يُطلب التاريخ عند الشراء ويُباع الأقرب انتهاءً أولًا)</label>}
              <label className="check"><input type="checkbox" checked={f.isWeighted} onChange={(e) => set('isWeighted', e.target.checked)} /> يُباع بالوزن (يطلب الوزن عند البيع)</label>
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
