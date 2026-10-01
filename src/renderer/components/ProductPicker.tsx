import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../lib/api';
import { money, qty } from '../lib/format';

export interface PickedProduct {
  id: number; name: string; variant_name: string | null; sell_price: number; avg_cost: number | null; unit_symbol: string; stock: number; barcode: string | null; allow_decimal: number;
}

/** Search-as-you-type product selector. Enter picks the first/exact result (works with barcode scanners). */
export function ProductPicker({ onPick, placeholder, autoFocus, status = 'active' }: { onPick: (p: PickedProduct) => void; placeholder?: string; autoFocus?: boolean; status?: 'active' | 'all' }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PickedProduct[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!q.trim()) { setItems([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      api('products.list', { q, pageSize: 12, status }).then((r) => { if (alive) { setItems(r.rows); setHi(0); setOpen(true); } }).catch(() => {});
    }, 120);
    return () => { alive = false; clearTimeout(t); };
  }, [q, status]);
  const choose = (p: PickedProduct) => { onPick(p); setQ(''); setItems([]); setOpen(false); ref.current?.focus(); };
  return (
    <div style={{ position: 'relative' }}>
      <Search size={17} style={{ position: 'absolute', right: 10, top: 11, color: 'var(--text-3)' }} />
      <input ref={ref} className="input" style={{ paddingInlineStart: 34 }} autoFocus={autoFocus} placeholder={placeholder ?? 'ابحث عن منتج بالاسم أو الباركود ثم اضغط Enter'} value={q}
        onChange={(e) => setQ(e.target.value)} onFocus={() => items.length && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={async (e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (items[hi]) return choose(items[hi]);
            if (q.trim()) { const r = await api('products.list', { q, pageSize: 2, status }); if (r.rows.length) choose(r.rows[0]); }
          }
          if (e.key === 'Escape') setOpen(false);
        }} />
      {open && items.length > 0 && (
        <div className="card" style={{ position: 'absolute', top: 42, left: 0, right: 0, zIndex: 20, maxHeight: 320, overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}>
          {items.map((p, i) => (
            <div key={p.id} onMouseDown={() => choose(p)} className="row" style={{ padding: '8px 12px', cursor: 'pointer', background: i === hi ? 'var(--primary-50)' : undefined, borderBottom: '1px solid var(--border)' }}>
              <div className="grow"><div className="bold">{p.name}{p.variant_name ? ` ${p.variant_name}` : ''}</div><div className="xs muted num">{p.barcode ?? ''}</div></div>
              <div className="small muted">المخزون {qty(p.stock)} {p.unit_symbol}</div>
              <div className="bold num">{money(p.sell_price)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
