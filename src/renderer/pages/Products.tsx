import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Package, Plus, Search, Star, Tags, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { money, qty } from '../lib/format';
import { Empty, Loading, Modal, PageHeader, Pager, useAction } from '../components/ui';
import { parseDecimal } from '../../shared/arabic';

export default function Products() {
  const { can } = useApp();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const categoryId = Number(params.get('category')) || null;
  const stock = (params.get('stock') as 'low' | 'out' | 'negative' | null) || null;
  const status = (params.get('status') as 'active' | 'inactive' | 'all') || 'active';
  const [importOpen, setImportOpen] = useState(false);
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('categories.list') });
  const list = useQuery({
    queryKey: ['products', q, page, categoryId, stock, status],
    queryFn: () => api('products.list', { q, page, pageSize: 50, categoryId, stock, status }),
    placeholderData: (p) => p,
  });
  const setParam = (k: string, v: string | null) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n); setPage(1); };
  return (
    <div>
      <PageHeader title="المنتجات" sub={list.data ? `${list.data.total} منتج` : undefined} icon={<Package color="var(--primary)" />}
        actions={can('products.manage') && <>
          <Link to="/catalog" className="btn"><Tags size={16} /> التصنيفات والوحدات</Link>
          <button className="btn" onClick={() => setImportOpen(true)}><Upload size={16} /> استيراد من Excel</button>
          <Link to="/products/new" className="btn primary"><Plus size={16} /> منتج جديد</Link>
        </>} />
      <div className="card">
        <div className="row wrap" style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
          <div className="row grow" style={{ position: 'relative', minWidth: 260 }}>
            <Search size={17} style={{ position: 'absolute', right: 10, color: 'var(--text-3)' }} />
            <input className="input" style={{ paddingInlineStart: 34 }} placeholder="بحث بالاسم، الباركود، الكود، البراند…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} autoFocus />
          </div>
          <select className="select" style={{ width: 180 }} value={categoryId ?? ''} onChange={(e) => setParam('category', e.target.value || null)}>
            <option value="">كل التصنيفات</option>
            {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="select" style={{ width: 170 }} value={stock ?? ''} onChange={(e) => setParam('stock', e.target.value || null)}>
            <option value="">كل الأرصدة</option><option value="low">وصل للحد الأدنى</option><option value="out">نفد (صفر أو أقل)</option><option value="negative">رصيد بالسالب</option>
          </select>
          <select className="select" style={{ width: 130 }} value={status} onChange={(e) => setParam('status', e.target.value === 'active' ? null : e.target.value)}>
            <option value="active">النشطة</option><option value="inactive">الموقوفة</option><option value="all">الكل</option>
          </select>
        </div>
        {list.isLoading ? <Loading /> : !list.data?.rows.length ? (
          <Empty title={q ? 'لا توجد نتائج' : 'لم تضف أي منتج بعد'} desc={q ? undefined : 'ابدأ بإضافة أول منتج — يكفي الاسم والسعر.'}
            action={can('products.manage') && !q && <Link className="btn primary" to="/products/new"><Plus size={16} /> إضافة أول منتج</Link>} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>المنتج</th><th>التصنيف</th><th>الباركود / الكود</th><th className="n">سعر البيع</th>{can('reports.cost') && <th className="n">التكلفة</th>}<th className="n">المخزون</th><th /></tr></thead>
              <tbody>
                {list.data.rows.map((p: any) => (
                  <tr key={p.id} className="clickable" onClick={() => nav(`/products/${p.id}`)}>
                    <td>
                      <div className="bold">{p.is_favorite ? <Star size={13} color="var(--accent)" fill="var(--accent)" /> : null} {p.name}{p.variant_name ? ` ${p.variant_name}` : ''}</div>
                      <div className="xs muted">{p.brand_name}{p.is_weighted ? ' • بالوزن' : ''}{p.track_expiry ? ' • له صلاحية' : ''}</div>
                    </td>
                    <td>{p.category_name ?? <span className="muted">—</span>}</td>
                    <td className="num small">{p.barcode || p.sku || <span className="muted">—</span>}</td>
                    <td className="n bold">{money(p.sell_price)}<span className="xs muted"> / {p.unit_symbol}</span></td>
                    {can('reports.cost') && <td className="n muted">{p.avg_cost ? money(Math.round(p.avg_cost)) : '—'}</td>}
                    <td className="n">
                      <span className={p.stock < 0 ? 'danger-text bold' : p.min_stock > 0 && p.stock <= p.min_stock ? 'warning-text bold' : ''}>{qty(p.stock)}</span> <span className="xs muted">{p.unit_symbol}</span>
                    </td>
                    <td>{!p.active && <span className="badge">موقوف</span>}{p.min_stock > 0 && p.stock <= p.min_stock && p.active ? <span className="badge warning">منخفض</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
          </div>
        )}
      </div>
      {importOpen && <ImportDialog onClose={() => { setImportOpen(false); void list.refetch(); }} />}
    </div>
  );
}

/** Paste rows from Excel (tab separated): name, barcode, category, unit, price, cost, qty, min */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const { run, busy } = useAction();
  const rows = text.split(/\r?\n/).map((l) => l.split('\t')).filter((c) => c[0]?.trim());
  const parsed = rows.map((c) => ({
    name: c[0]?.trim(), barcode: c[1]?.trim() || undefined, category: c[2]?.trim() || undefined, unit: c[3]?.trim() || undefined,
    sellPrice: Math.round((parseDecimal(c[4]) ?? 0) * 100), cost: Math.round((parseDecimal(c[5]) ?? 0) * 100), qty: Math.round((parseDecimal(c[6]) ?? 0) * 1000), minStock: Math.round((parseDecimal(c[7]) ?? 0) * 1000),
  })).filter((r) => r.name && !/^(الاسم|اسم)/.test(r.name));
  return (
    <Modal title="استيراد منتجات من Excel" size="lg" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>إغلاق</button><button className="btn primary" disabled={busy || !parsed.length} onClick={() => run(async () => setResult(await api('products.import', { rows: parsed })))}>استيراد {parsed.length} منتج</button></>}>
      <div className="col">
        <div className="alert info small">انسخ الأعمدة من Excel بالترتيب التالي ثم الصقها هنا: <b>الاسم — الباركود — التصنيف — الوحدة — سعر البيع — سعر الشراء — الكمية الحالية — الحد الأدنى</b>. الأعمدة بعد الاسم والسعر اختيارية.</div>
        <textarea className="input" rows={10} dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder="الصق هنا…" />
        {result && <div className={`alert ${result.errors.length ? 'warning' : 'success'}`}>تمت إضافة {result.created} منتج.{result.errors.length ? ` تم تخطي ${result.skipped} صف (مثلًا باركود مكرر): ${result.errors.slice(0, 5).map((e: any) => `صف ${e.row}`).join('، ')}` : ''}</div>}
      </div>
    </Modal>
  );
}
