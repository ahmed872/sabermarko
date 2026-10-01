import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Tags, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { dateOnly, money, qty } from '../lib/format';
import { Empty, Field, Modal, MoneyInput, NumberInput, PageHeader, QtyInput, Segmented, Tabs, useAction, useConfirm } from '../components/ui';
import { ProductPicker } from '../components/ProductPicker';

type Tab = 'categories' | 'brands' | 'units' | 'promotions';

export default function Catalog() {
  const { feature } = useApp();
  const [tab, setTab] = useState<Tab>('categories');
  return (
    <div>
      <PageHeader title="التصنيفات والوحدات والعروض" icon={<Tags color="var(--primary)" />} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'categories', label: 'التصنيفات' }, { value: 'brands', label: 'البراندات' }, { value: 'units', label: 'الوحدات' }, { value: 'promotions', label: 'العروض', hidden: !feature('promotions') }]} />
      {tab === 'categories' && <SimpleList kind="categories" />}
      {tab === 'brands' && <SimpleList kind="brands" />}
      {tab === 'units' && <UnitsTab />}
      {tab === 'promotions' && <PromotionsTab />}
    </div>
  );
}

function SimpleList({ kind }: { kind: 'categories' | 'brands' }) {
  const list = useQuery({ queryKey: [kind, 'all'], queryFn: () => api<any[]>(`${kind}.list`, { all: true }) });
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<{ id: number; name: string } | null>(null);
  const { run } = useAction();
  const confirm = useConfirm();
  return (
    <div className="card" style={{ maxWidth: 700 }}>
      <form className="row" style={{ padding: 12, borderBottom: '1px solid var(--border)' }} onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(async () => { await api(`${kind}.save`, { name }); setName(''); await list.refetch(); }); }}>
        <input className="input" placeholder={kind === 'categories' ? 'اسم تصنيف جديد' : 'اسم براند جديد'} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary"><Plus size={16} /> إضافة</button>
      </form>
      {!list.data?.length ? <Empty title="لا توجد عناصر" /> : (
        <table className="table"><tbody>{list.data.map((c) => (
          <tr key={c.id}>
            <td>{edit?.id === c.id ? <input className="input" autoFocus value={edit!.name} onChange={(e) => setEdit({ id: c.id, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void run(async () => { await api(`${kind}.save`, { id: c.id, name: edit!.name, active: true }); setEdit(null); await list.refetch(); }); if (e.key === 'Escape') setEdit(null); }} /> : <span className="bold" onDoubleClick={() => setEdit({ id: c.id, name: c.name })}>{c.name}</span>}</td>
            <td className="n muted small">{c.product_count} منتج</td>
            <td className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
              <button className="btn sm" onClick={() => setEdit({ id: c.id, name: c.name })}>تعديل</button>
              <button className="btn ghost sm icon" onClick={async () => { if ((await confirm({ title: 'حذف', message: `حذف "${c.name}"؟`, danger: true, confirmText: 'حذف' })).ok) void run(async () => { await api(`${kind}.delete`, { id: c.id }); await list.refetch(); }); }}><Trash2 size={14} /></button>
            </td>
          </tr>
        ))}</tbody></table>
      )}
    </div>
  );
}

function UnitsTab() {
  const list = useQuery({ queryKey: ['units'], queryFn: () => api<any[]>('units.list') });
  const [f, setF] = useState({ name: '', kind: 'count' as 'count' | 'weight' | 'volume', allowDecimal: false });
  const { run } = useAction();
  const kinds = { count: 'عدد', weight: 'وزن', volume: 'حجم' };
  return (
    <div className="card" style={{ maxWidth: 760 }}>
      <form className="row wrap" style={{ padding: 12, borderBottom: '1px solid var(--border)' }} onSubmit={(e) => { e.preventDefault(); if (f.name.trim()) void run(async () => { await api('units.save', f); setF({ name: '', kind: 'count', allowDecimal: false }); await list.refetch(); }, 'تمت إضافة الوحدة'); }}>
        <input className="input" style={{ width: 200 }} placeholder="اسم وحدة جديدة (مثال: شريط)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Segmented value={f.kind} onChange={(k) => setF({ ...f, kind: k, allowDecimal: k !== 'count' })} options={[{ value: 'count', label: 'عدد' }, { value: 'weight', label: 'وزن' }, { value: 'volume', label: 'حجم' }]} />
        <label className="check small"><input type="checkbox" checked={f.allowDecimal} onChange={(e) => setF({ ...f, allowDecimal: e.target.checked })} /> تقبل كسور</label>
        <button className="btn primary"><Plus size={16} /> إضافة</button>
      </form>
      <table className="table"><thead><tr><th>الوحدة</th><th>الرمز</th><th>النوع</th><th>كسور</th><th /></tr></thead>
        <tbody>{(list.data ?? []).map((u) => <tr key={u.id}><td className="bold">{u.name}</td><td>{u.symbol}</td><td>{kinds[u.kind as keyof typeof kinds]}</td><td>{u.allow_decimal ? 'نعم' : 'لا'}</td><td>{u.is_system ? <span className="badge">أساسية</span> : null}</td></tr>)}</tbody></table>
      <div className="small muted" style={{ padding: 12 }}>تحويل الوحدات (مثل: الكرتونة = 30 كيس) يُحدد داخل كل منتج لأنه يختلف من منتج لآخر.</div>
    </div>
  );
}

const PROMO_TYPES = { percent: 'خصم نسبة', amount: 'خصم مبلغ على الوحدة', bundle: 'سعر خاص لكمية (مثال: 2 بـ 25)', bxgy: 'اشترِ X واحصل على Y مجانًا' };

function PromotionsTab() {
  const list = useQuery({ queryKey: ['promotions'], queryFn: () => api<any[]>('promotions.list') });
  const [edit, setEdit] = useState<any | null>(null);
  const describe = (p: any) => {
    switch (p.type) {
      case 'percent': return `خصم ${p.value / 100}%${p.min_qty > 1000 ? ` عند شراء ${qty(p.min_qty)} أو أكثر` : ''}`;
      case 'amount': return `خصم ${money(p.value)} على كل وحدة`;
      case 'bundle': return `${qty(p.min_qty)} بـ ${money(p.value)}`;
      case 'bxgy': return `اشترِ ${qty(p.min_qty)} واحصل على ${qty(p.get_qty)} مجانًا`;
    }
    return '';
  };
  return (
    <div>
      <div className="row mb"><div className="alert info small grow">العروض تُطبق تلقائيًا في شاشة البيع، وتُخصم من الإيراد مع بقاء المخزون والتكلفة صحيحين.</div><button className="btn primary" onClick={() => setEdit({})}><Plus size={16} /> عرض جديد</button></div>
      <div className="card">
        {!list.data?.length ? <Empty title="لا توجد عروض" /> : (
          <table className="table"><thead><tr><th>العرض</th><th>على</th><th>التفاصيل</th><th>من</th><th>إلى</th><th>الحالة</th></tr></thead>
            <tbody>{list.data.map((p) => <tr key={p.id} className="clickable" onClick={() => setEdit(p)}><td className="bold">{p.name}</td><td>{p.product_name ?? `تصنيف: ${p.category_name}`}</td><td>{describe(p)}</td><td className="num small">{dateOnly(p.start_date)}</td><td className="num small">{dateOnly(p.end_date)}</td><td>{p.active ? <span className="badge success">مفعل</span> : <span className="badge">متوقف</span>}</td></tr>)}</tbody></table>
        )}
      </div>
      {edit && <PromotionDialog promo={edit} onClose={() => { setEdit(null); void list.refetch(); }} />}
    </div>
  );
}

function PromotionDialog({ promo, onClose }: { promo: any; onClose: () => void }) {
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('categories.list') });
  const { run, busy } = useAction();
  const [f, setF] = useState({
    name: promo.name ?? '', type: (promo.type ?? 'percent') as keyof typeof PROMO_TYPES, productId: promo.product_id ?? null, productName: promo.product_name ?? '', categoryId: promo.category_id ?? '',
    minQty: promo.min_qty ?? 1000, getQty: promo.get_qty ?? 1000, value: promo.value ?? null, startDate: promo.start_date ?? '', endDate: promo.end_date ?? '', active: promo.active ?? 1,
  });
  const [target, setTarget] = useState<'product' | 'category'>(promo.category_id ? 'category' : 'product');
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal title={promo.id ? 'تعديل العرض' : 'عرض جديد'} size="lg" onClose={onClose} footer={<>
      {promo.id && <button className="btn danger outline" onClick={() => run(async () => { await api('promotions.delete', { id: promo.id }); onClose(); })}>حذف</button>}
      <div className="grow" />
      <button className="btn primary" disabled={busy} onClick={() => run(async () => {
        await api('promotions.save', { id: promo.id ?? null, data: { name: f.name, type: f.type, productId: target === 'product' ? f.productId : null, categoryId: target === 'category' ? f.categoryId || null : null, minQty: f.minQty, getQty: f.type === 'bxgy' ? f.getQty : 0, value: f.type === 'bxgy' ? 0 : f.value ?? 0, startDate: f.startDate || null, endDate: f.endDate || null, active: !!f.active } });
        onClose();
      }, 'تم حفظ العرض')}>حفظ</button></>}>
      <div className="col">
        <Field label="اسم العرض"><input className="input" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="مثال: عرض البسكويت" /></Field>
        <Field label="نوع العرض"><select className="select" value={f.type} onChange={(e) => set('type', e.target.value)}>{Object.entries(PROMO_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Segmented value={target} onChange={setTarget} options={[{ value: 'product', label: 'على منتج' }, { value: 'category', label: 'على تصنيف كامل' }]} />
        {target === 'product' ? (
          <Field label={f.productName ? `المنتج: ${f.productName}` : 'المنتج'}><ProductPicker onPick={(p) => setF((x) => ({ ...x, productId: p.id, productName: p.name }))} /></Field>
        ) : (
          <Field label="التصنيف"><select className="select" value={f.categoryId} onChange={(e) => set('categoryId', Number(e.target.value) || '')}><option value="">اختر</option>{(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        )}
        <div className="grid grid-2">
          {f.type === 'percent' && <><Field label="نسبة الخصم %"><NumberInput value={f.value === null ? null : f.value / 100} onChange={(v) => set('value', v === null ? null : Math.round(v * 100))} /></Field><Field label="أقل كمية"><QtyInput value={f.minQty} onChange={(v) => set('minQty', v ?? 1000)} /></Field></>}
          {f.type === 'amount' && <><Field label="الخصم على كل وحدة"><MoneyInput value={f.value} onChange={(v) => set('value', v)} /></Field><Field label="أقل كمية"><QtyInput value={f.minQty} onChange={(v) => set('minQty', v ?? 1000)} /></Field></>}
          {f.type === 'bundle' && <><Field label="الكمية"><QtyInput value={f.minQty} onChange={(v) => set('minQty', v ?? 1000)} /></Field><Field label="بسعر إجمالي"><MoneyInput value={f.value} onChange={(v) => set('value', v)} /></Field></>}
          {f.type === 'bxgy' && <><Field label="اشترِ"><QtyInput value={f.minQty} onChange={(v) => set('minQty', v ?? 1000)} /></Field><Field label="واحصل مجانًا على"><QtyInput value={f.getQty} onChange={(v) => set('getQty', v ?? 1000)} /></Field></>}
          <Field label="من تاريخ"><input type="date" className="input" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
          <Field label="إلى تاريخ"><input type="date" className="input" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={!!f.active} onChange={(e) => set('active', e.target.checked ? 1 : 0)} /> مفعل</label>
      </div>
    </Modal>
  );
}
