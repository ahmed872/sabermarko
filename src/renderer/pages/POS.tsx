import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Banknote, CreditCard, Minus, PauseCircle, Percent, Plus, Printer, Scale, Search, Smartphone, Star, Trash2, User, UserPlus, Wallet, X, PlayCircle, FileText, Lock,
} from 'lucide-react';
import { api, apiApproved } from '../lib/api';
import { useApp } from '../lib/app';
import { METHOD_LABEL, money, qty as fmtQty, dateTime } from '../lib/format';
import { Empty, Field, Modal, MoneyInput, NumberInput, QtyInput, Segmented, useAction, useConfirm, useToast } from '../components/ui';
import { normalizeArabic } from '../../shared/arabic';

/* ------------------------------------------------------------------ types */
interface PUnit { unit_id: number; factor: number; sell_price: number | null; is_default_sale: number; unit_name: string; unit_symbol: string; allow_decimal: number; barcode: string | null }
interface PProduct {
  id: number; name: string; short_name: string | null; variant_name: string | null; group_id: number | null; group_name: string | null; sell_price: number;
  is_weighted: number; allow_discount: number; base_unit_id: number; stock: number; category_id: number | null; units: PUnit[]; is_favorite: number;
  matchedUnitId?: number; matchedQty?: number; matchedPrice?: number;
}
interface Discount { type: 'amount' | 'percent'; value: number }
interface Line { key: string; productId: number; unitId: number; qty: number; unitPrice?: number | null; discount?: Discount | null; product: PProduct }
interface PricedLine { key?: string; productId: number; unitId: number; productName: string; unitName: string; qty: number; listPrice: number; unitPrice: number; gross: number; promoDiscount: number; promotionName: string | null; discount: number; invoiceDiscountShare: number; total: number; allowDecimal: boolean; stock: number; baseQty: number }
interface Priced { lines: PricedLine[]; subtotal: number; promoDiscount: number; lineDiscount: number; invoiceDiscount: number; taxTotal: number; rounding: number; total: number; itemsCount: number; missingApprovals: string[] }

let keySeq = 0;
const newKey = () => `l${Date.now().toString(36)}${(keySeq++).toString(36)}`;
const fullName = (p: PProduct) => (p.variant_name ? `${p.name} ${p.variant_name}` : p.name);
const defaultUnit = (p: PProduct) => p.units.find((u) => u.is_default_sale) ?? p.units.find((u) => u.unit_id === p.base_unit_id) ?? p.units[0];
const unitPriceOf = (p: PProduct, u: PUnit) => u.sell_price ?? Math.round((p.sell_price * u.factor) / 1000);

/* ------------------------------------------------------------------ POS */
export default function POS() {
  const { can, settings, feature, user } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);

  const [lines, setLines] = useState<Line[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [customer, setCustomer] = useState<{ id: number; name: string; balance: number; phone?: string } | null>(null);
  const [invoiceDiscount, setInvoiceDiscount] = useState<Discount | null>(null);
  const [priced, setPriced] = useState<Priced | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [heldId, setHeldId] = useState<number | null>(null);
  const [quotationId, setQuotationId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<number | 'fav' | 'all'>('fav');
  const [dialog, setDialog] = useState<null | { kind: 'weight' | 'line' | 'customer' | 'invoiceDiscount' | 'pay' | 'held' | 'variants' | 'receipt' | 'cash' | 'quote'; data?: any }>(null);

  const shift = useQuery({ queryKey: ['shift'], queryFn: () => api('shifts.current') });
  const needShift = settings['sales.requireShift'] && shift.isFetched && !shift.data;
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => api<any[]>('categories.list') });
  const heldCount = useQuery({ queryKey: ['held'], queryFn: () => api<any[]>('held.list') });

  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebouncedQ(q), 140); return () => clearTimeout(t); }, [q]);
  const browse = useQuery({
    queryKey: ['pos-browse', debouncedQ, cat],
    queryFn: () => api<{ exact: boolean; items: PProduct[] }>('pos.search', { q: debouncedQ, categoryId: !debouncedQ && typeof cat === 'number' ? cat : null, favorites: !debouncedQ && cat === 'fav', limit: 60 }),
    placeholderData: (prev) => prev,
  });
  // when there are no favourites yet, show all products instead of an empty screen
  useEffect(() => { if (cat === 'fav' && !debouncedQ && browse.isFetched && browse.data && browse.data.items.length === 0 && !browse.isFetching) setCat('all'); }, [browse.data, browse.isFetched, browse.isFetching, cat, debouncedQ]);

  const focusSearch = useCallback(() => setTimeout(() => searchRef.current?.focus(), 0), []);

  /* ---------------- pricing (authoritative, from the main process) */
  const cartPayload = useCallback((ls: Line[] = lines) => ({
    customerId: customer?.id ?? null,
    invoiceDiscount,
    lines: ls.map((l) => ({ key: l.key, productId: l.productId, unitId: l.unitId, qty: l.qty, unitPrice: l.unitPrice ?? null, discount: l.discount ?? null })),
  }), [lines, customer, invoiceDiscount]);

  useEffect(() => {
    let alive = true;
    if (!lines.length) { setPriced(null); setQuoteError(null); return; }
    api<Priced>('sales.quote', cartPayload()).then((p) => { if (alive) { setPriced(p); setQuoteError(null); } }).catch((e) => { if (alive) setQuoteError(e.message); });
    return () => { alive = false; };
  }, [cartPayload, lines.length]);

  const pricedByKey = useMemo(() => new Map((priced?.lines ?? []).map((l) => [l.key, l])), [priced]);

  /* ---------------- cart operations */
  const addLine = useCallback((p: PProduct, unitId?: number, qtyMilli?: number, unitPrice?: number | null) => {
    const unit = p.units.find((u) => u.unit_id === unitId) ?? defaultUnit(p);
    if (!unit) return;
    const addQty = qtyMilli ?? 1000;
    setLines((ls) => {
      // merge with the last identical line (same product/unit, no manual changes) for count-based items
      const idx = ls.findIndex((l) => l.productId === p.id && l.unitId === unit.unit_id && !l.unitPrice && !l.discount && !p.is_weighted && !unit.allow_decimal);
      if (idx >= 0 && qtyMilli === undefined) {
        const copy = [...ls];
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + addQty };
        setSelected(copy[idx].key);
        return copy;
      }
      const line: Line = { key: newKey(), productId: p.id, unitId: unit.unit_id, qty: addQty, unitPrice: unitPrice ?? null, product: p };
      setSelected(line.key);
      return [...ls, line];
    });
  }, []);

  /** Decide how to add a product: variants picker, weight dialog, or directly. */
  const pick = useCallback(async (p: PProduct, opts: { fromScan?: boolean } = {}) => {
    if (p.matchedQty || p.matchedPrice) {
      // scale label: weight in grams, or price
      const base = p.units.find((u) => u.unit_id === p.base_unit_id)!;
      if (p.matchedQty) addLine(p, base.unit_id, Math.round((p.matchedQty * 1000) / base.factor));
      else {
        const perBase = unitPriceOf(p, base);
        addLine(p, base.unit_id, Math.max(1, Math.round((p.matchedPrice! * 1000) / perBase)));
      }
      return;
    }
    if (p.is_weighted) { setDialog({ kind: 'weight', data: p }); return; }
    addLine(p, p.matchedUnitId);
    if (opts.fromScan) setQ('');
  }, [addLine]);

  const onSearchEnter = async () => {
    const term = q.trim();
    if (!term) { if (lines.length) setDialog({ kind: 'pay' }); return; }
    try {
      const r = await api<{ exact: boolean; items: PProduct[] }>('pos.search', { q: term, limit: 20 });
      if (r.exact && r.items.length === 1) { await pick(r.items[0], { fromScan: true }); setQ(''); return; }
      if (r.items.length === 1) { await pick(r.items[0]); setQ(''); return; }
      if (!r.items.length) toast(`لا يوجد منتج بالاسم أو الكود "${term}"`, 'error');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const updateLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) => setLines((ls) => {
    const i = ls.findIndex((l) => l.key === key);
    const next = ls.filter((l) => l.key !== key);
    setSelected(next.length ? next[Math.min(i, next.length - 1)].key : null);
    return next;
  });
  const step = (key: string, dir: 1 | -1) => {
    const l = lines.find((x) => x.key === key);
    if (!l) return;
    const unit = l.product.units.find((u) => u.unit_id === l.unitId);
    const inc = unit?.allow_decimal ? (unit.factor < 1000 ? 50_000 : 100) : 1000; // 50 g / 0.1 kg / 1 piece
    const nq = l.qty + dir * inc;
    if (nq <= 0) removeLine(key); else updateLine(key, { qty: nq });
  };

  const resetSale = useCallback(() => {
    setLines([]); setSelected(null); setCustomer(null); setInvoiceDiscount(null); setHeldId(null); setQuotationId(null); setQ(''); setPriced(null);
    focusSearch();
  }, [focusSearch]);

  const loadCart = useCallback(async (cart: any, opts: { heldId?: number; quotationId?: number } = {}) => {
    const loaded: Line[] = [];
    for (const l of cart.lines ?? []) {
      try {
        const p = await api<PProduct>('pos.product', { id: l.productId });
        loaded.push({ key: newKey(), productId: l.productId, unitId: l.unitId, qty: l.qty, unitPrice: l.unitPrice ?? null, discount: l.discount ?? null, product: p });
      } catch { toast('تم تخطي منتج لم يعد متاحًا', 'error'); }
    }
    setLines(loaded);
    setSelected(loaded[0]?.key ?? null);
    setInvoiceDiscount(cart.invoiceDiscount ?? null);
    if (cart.customerId) {
      try { const c = await api('customers.get', { id: cart.customerId }); setCustomer({ id: c.id, name: c.name, balance: c.balance, phone: c.phone }); } catch { setCustomer(null); }
    } else setCustomer(null);
    setHeldId(opts.heldId ?? null);
    setQuotationId(opts.quotationId ?? null);
  }, [toast]);

  // open a quotation passed via ?quotation=ID, or held list via ?held=1
  useEffect(() => {
    const qid = Number(params.get('quotation'));
    if (qid) {
      api('quotations.get', { id: qid }).then((qt) => loadCart(qt.cart, { quotationId: qid })).catch((e) => toast(e.message, 'error'));
      setParams({}, { replace: true });
    } else if (params.get('held')) { setDialog({ kind: 'held' }); setParams({}, { replace: true }); }
  }, [params, setParams, loadCart, toast]);

  const hold = async () => {
    if (!lines.length) return;
    try {
      await api('held.create', { cart: cartPayload(), label: customer?.name ?? null });
      if (heldId) await api('held.delete', { id: heldId }).catch(() => {});
      toast('تم تعليق الفاتورة', 'success');
      void qc.invalidateQueries({ queryKey: ['held'] });
      resetSale();
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const cancelSale = async () => {
    if (!lines.length) return;
    const r = await confirm({ title: 'إلغاء الفاتورة الحالية', message: 'سيتم مسح كل الأصناف من الفاتورة الحالية. هل أنت متأكد؟', confirmText: 'مسح الفاتورة', danger: true });
    if (r.ok) resetSale();
  };

  /* ---------------- keyboard */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      const sel = selected && lines.find((l) => l.key === selected);
      const inSearch = document.activeElement === searchRef.current;
      switch (e.key) {
        case 'F1': e.preventDefault(); if (lines.length) void cancelSale(); else resetSale(); return;
        case 'F2': e.preventDefault(); focusSearch(); return;
        case 'F3': e.preventDefault(); if (sel) setDialog({ kind: 'line', data: { key: sel.key, focus: 'qty' } }); return;
        case 'F4': e.preventDefault(); if (sel) setDialog({ kind: 'line', data: { key: sel.key, focus: 'discount' } }); return;
        case 'F5': e.preventDefault(); setDialog({ kind: 'customer' }); return;
        case 'F6': e.preventDefault(); void hold(); return;
        case 'F7': e.preventDefault(); setDialog({ kind: 'held' }); return;
        case 'F8': e.preventDefault(); if (lines.length) setDialog({ kind: 'invoiceDiscount' }); return;
        case 'F9': e.preventDefault(); if (lines.length) setDialog({ kind: 'pay' }); return;
        case 'Escape': if (inSearch && q) { setQ(''); return; } e.preventDefault(); void cancelSale(); return;
        case 'Delete': if (sel && (!inSearch || !q)) { e.preventDefault(); removeLine(sel.key); } return;
        case 'ArrowDown': case 'ArrowUp': {
          if (!lines.length || (inSearch && q)) return;
          e.preventDefault();
          const i = lines.findIndex((l) => l.key === selected);
          const ni = e.key === 'ArrowDown' ? Math.min(lines.length - 1, i + 1) : Math.max(0, i - 1);
          setSelected(lines[ni].key);
          return;
        }
        case '+': if (sel && (!inSearch || !q)) { e.preventDefault(); step(sel.key, 1); } return;
        case '-': if (sel && (!inSearch || !q)) { e.preventDefault(); step(sel.key, -1); } return;
        default:
          // barcode scanners type fast into whatever has focus: route characters to the search box
          if (!inSearch && e.key.length === 1 && !e.ctrlKey && !e.altKey && !(document.activeElement instanceof HTMLInputElement) && !(document.activeElement instanceof HTMLTextAreaElement) && !(document.activeElement instanceof HTMLSelectElement)) {
            searchRef.current?.focus();
          }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ---------------- tiles (group variants under one tile when browsing) */
  const tiles = useMemo(() => {
    const items = browse.data?.items ?? [];
    if (debouncedQ) return items.map((p) => ({ kind: 'p' as const, p }));
    const out: ({ kind: 'p'; p: PProduct } | { kind: 'g'; id: number; name: string; items: PProduct[] })[] = [];
    const groups = new Map<number, { kind: 'g'; id: number; name: string; items: PProduct[] }>();
    for (const p of items) {
      if (p.group_id) {
        let g = groups.get(p.group_id);
        if (!g) { g = { kind: 'g', id: p.group_id, name: p.group_name ?? p.name, items: [] }; groups.set(p.group_id, g); out.push(g); }
        g.items.push(p);
      } else out.push({ kind: 'p', p });
    }
    return out.map((t) => (t.kind === 'g' && t.items.length === 1 ? { kind: 'p' as const, p: t.items[0] } : t));
  }, [browse.data, debouncedQ]);

  const selLine = lines.find((l) => l.key === selected) ?? null;

  if (needShift) return <OpenShift onOpened={() => { void shift.refetch(); focusSearch(); }} />;

  return (
    <div className="pos">
      <div className="pos-left">
        <div className="pos-search">
          <div className="search-wrap">
            <Search size={20} />
            <input ref={searchRef} className="input" autoFocus placeholder="ابحث باسم المنتج أو الكود أو امسح الباركود…  (F2)" value={q}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onSearchEnter(); } }} />
          </div>
          {q && <button className="btn icon lg" onClick={() => { setQ(''); focusSearch(); }} aria-label="مسح البحث"><X size={18} /></button>}
        </div>
        {!debouncedQ && (
          <div className="cats">
            <button className={cat === 'fav' ? 'on' : ''} onClick={() => setCat('fav')}><Star size={13} /> المنتجات السريعة</button>
            <button className={cat === 'all' ? 'on' : ''} onClick={() => setCat('all')}>الكل</button>
            {(cats.data ?? []).filter((c) => c.product_count > 0).map((c) => <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{c.name}</button>)}
          </div>
        )}
        <div className="tiles">
          {tiles.map((t) => t.kind === 'p' ? (
            <button key={`p${t.p.id}`} className="tile" onClick={() => { void pick(t.p); focusSearch(); }}>
              <span className="tn">{fullName(t.p)}</span>
              <span className={`ts ${t.p.stock <= 0 ? 'low' : ''}`}>{t.p.is_weighted ? <><Scale size={11} /> بالوزن — </> : null}المتاح: {fmtQty(t.p.stock)}</span>
              <span className="tp">{money(t.p.sell_price)}{t.p.is_weighted ? <span className="xs muted"> / {t.p.units.find((u) => u.unit_id === t.p.base_unit_id)?.unit_symbol}</span> : null}</span>
            </button>
          ) : (
            <button key={`g${t.id}`} className="tile group" onClick={() => setDialog({ kind: 'variants', data: t })}>
              <span className="tn">{t.name}</span>
              <span className="ts">{t.items.length} أحجام/أنواع</span>
              <span className="tp">اختر النوع</span>
            </button>
          ))}
          {browse.isFetched && !tiles.length && (
            <div style={{ gridColumn: '1 / -1' }}>
              <Empty title={debouncedQ ? 'لا توجد نتائج' : 'لا توجد منتجات بعد'} desc={debouncedQ ? 'جرّب كلمة أخرى أو امسح الباركود مرة أخرى.' : 'أضف منتجاتك من صفحة المنتجات لتظهر هنا.'} />
            </div>
          )}
        </div>
      </div>

      <div className="pos-right">
        <div className="cart-head">
          <button className="btn sm" onClick={() => setDialog({ kind: 'customer' })}>
            {customer ? <><User size={15} /> {customer.name}</> : <><UserPlus size={15} /> عميل نقدي</>}
          </button>
          {customer && <button className="btn ghost sm icon" onClick={() => setCustomer(null)} aria-label="إزالة العميل"><X size={14} /></button>}
          <div className="grow" />
          {heldId && <span className="badge info">فاتورة مستعادة</span>}
          {quotationId && <span className="badge info">من عرض سعر</span>}
          <span className="muted small">{lines.length} صنف</span>
        </div>
        <div className="cart-lines">
          {!lines.length && <Empty title="الفاتورة فارغة" desc="اختر المنتجات من اليمين أو امسح الباركود." icon={<Banknote size={26} />} />}
          {lines.map((l) => {
            const pl = pricedByKey.get(l.key);
            const unit = l.product.units.find((u) => u.unit_id === l.unitId);
            const disc = (pl?.discount ?? 0) + (pl?.promoDiscount ?? 0);
            return (
              <div key={l.key} className={`cart-line ${l.key === selected ? 'sel' : ''}`} onClick={() => setSelected(l.key)} onDoubleClick={() => setDialog({ kind: 'line', data: { key: l.key } })}>
                <div>
                  <div className="ln">{fullName(l.product)}</div>
                  <div className="ld">
                    {unit && unit.factor < 1000
                      ? <>{money(Math.round(((pl?.unitPrice ?? unitPriceOf(l.product, unit)) * 1000) / unit.factor), false)} / {l.product.units.find((u) => u.unit_id === l.product.base_unit_id)?.unit_symbol}</>
                      : <>{money(pl?.unitPrice ?? unitPriceOf(l.product, unit!), false)} / {unit?.unit_symbol}</>}
                    {l.unitPrice ? <span className="badge warning" style={{ marginInlineStart: 6 }}>سعر معدل</span> : null}
                    {disc > 0 && <span className="badge success" style={{ marginInlineStart: 6 }}>{pl?.promotionName ? `عرض: ${pl.promotionName}` : 'خصم'} {money(disc, false)}</span>}
                    {pl && pl.stock - pl.baseQty < 0 && <span className="badge danger" style={{ marginInlineStart: 6 }}>الرصيد غير كافٍ</span>}
                  </div>
                </div>
                <div className="qty-ctl" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => step(l.key, 1)} aria-label="زيادة"><Plus size={14} /></button>
                  <span className="q num" onClick={() => setDialog({ kind: 'line', data: { key: l.key, focus: 'qty' } })}>{fmtQty(l.qty)} <span className="xs muted">{unit?.unit_symbol}</span></span>
                  <button onClick={() => step(l.key, -1)} aria-label="نقص"><Minus size={14} /></button>
                </div>
                <div className="lt num">{money((pl?.gross ?? 0) - disc, false)}</div>
              </div>
            );
          })}
        </div>
        {quoteError && <div className="alert danger" style={{ margin: '0 14px 8px' }}>{quoteError}</div>}
        <div className="cart-totals">
          <div className="tr"><span>الإجمالي قبل الخصم</span><span className="num">{money(priced?.subtotal ?? 0)}</span></div>
          {(priced?.promoDiscount ?? 0) + (priced?.lineDiscount ?? 0) + (priced?.invoiceDiscount ?? 0) > 0 && (
            <div className="tr success-text"><span>الخصومات</span><span className="num">- {money((priced?.promoDiscount ?? 0) + (priced?.lineDiscount ?? 0) + (priced?.invoiceDiscount ?? 0))}</span></div>
          )}
          {(priced?.taxTotal ?? 0) > 0 && <div className="tr"><span>الضريبة {settings['tax.inclusive'] ? '(شاملة)' : ''}</span><span className="num">{money(priced!.taxTotal)}</span></div>}
          {(priced?.rounding ?? 0) !== 0 && <div className="tr"><span>تقريب</span><span className="num">{money(priced!.rounding)}</span></div>}
          <div className="grand"><span>الإجمالي</span><span className="num">{money(priced?.total ?? 0)}</span></div>
        </div>
        <div className="cart-actions">
          <button className="btn" disabled={!selLine} onClick={() => selLine && setDialog({ kind: 'line', data: { key: selLine.key, focus: 'qty' } })}>الكمية<span className="kbd">F3</span></button>
          <button className="btn" disabled={!selLine || !can('pos.discount') && !can('pos.discount_large')} onClick={() => selLine && setDialog({ kind: 'line', data: { key: selLine.key, focus: 'discount' } })}>خصم صنف<span className="kbd">F4</span></button>
          <button className="btn" disabled={!lines.length} onClick={() => setDialog({ kind: 'invoiceDiscount' })}><Percent size={14} />خصم فاتورة<span className="kbd">F8</span></button>
          <button className="btn danger outline" disabled={!selLine} onClick={() => selLine && removeLine(selLine.key)}><Trash2 size={14} />حذف<span className="kbd">Del</span></button>
          <button className="btn" disabled={!lines.length} onClick={() => void hold()}><PauseCircle size={14} />تعليق<span className="kbd">F6</span></button>
          <button className="btn" onClick={() => setDialog({ kind: 'held' })}><PlayCircle size={14} />المعلقة {heldCount.data?.length ? `(${heldCount.data.length})` : ''}<span className="kbd">F7</span></button>
          {feature('quotations') && can('quotations.manage')
            ? <button className="btn" disabled={!lines.length} onClick={() => setDialog({ kind: 'quote' })}><FileText size={14} />عرض سعر</button>
            : <button className="btn" disabled={!can('cash.manage')} onClick={() => setDialog({ kind: 'cash' })}><Wallet size={14} />الدرج</button>}
          <button className="btn" disabled={!lines.length} onClick={() => void cancelSale()}><X size={14} />إلغاء<span className="kbd">Esc</span></button>
        </div>
        <div className="pay-bar">
          <button className="btn primary pay-btn" disabled={!lines.length || !priced || !!quoteError} onClick={() => setDialog({ kind: 'pay' })}>
            <Banknote size={24} /> الدفع <span className="num">{money(priced?.total ?? 0)}</span> <span className="kbd">F9</span>
          </button>
        </div>
      </div>

      {dialog?.kind === 'weight' && <WeightDialog product={dialog.data} onClose={() => { setDialog(null); focusSearch(); }} onAdd={(unitId, qm) => { addLine(dialog.data, unitId, qm); setDialog(null); setQ(''); focusSearch(); }} />}
      {dialog?.kind === 'variants' && (
        <Modal title={`اختر النوع — ${dialog.data.name}`} onClose={() => setDialog(null)} size="lg">
          <div className="tiles" style={{ padding: 0 }}>
            {dialog.data.items.map((p: PProduct) => (
              <button key={p.id} className="tile" onClick={() => { setDialog(null); void pick(p); focusSearch(); }}>
                <span className="tn">{p.variant_name || p.name}</span><span className="ts">المتاح: {fmtQty(p.stock)}</span><span className="tp">{money(p.sell_price)}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {dialog?.kind === 'line' && (() => {
        const l = lines.find((x) => x.key === dialog.data.key);
        if (!l) return null;
        return <LineDialog line={l} priced={pricedByKey.get(l.key)} focus={dialog.data.focus} onClose={() => { setDialog(null); focusSearch(); }}
          onSave={(patch) => { updateLine(l.key, patch); setDialog(null); focusSearch(); }} onRemove={() => { removeLine(l.key); setDialog(null); focusSearch(); }} />;
      })()}
      {dialog?.kind === 'customer' && <CustomerDialog onClose={() => { setDialog(null); focusSearch(); }} onPick={(c) => { setCustomer(c); setDialog(null); focusSearch(); }} />}
      {dialog?.kind === 'invoiceDiscount' && (
        <DiscountDialog title="خصم على الفاتورة" base={(priced?.subtotal ?? 0) - (priced?.promoDiscount ?? 0) - (priced?.lineDiscount ?? 0)} value={invoiceDiscount}
          onClose={() => { setDialog(null); focusSearch(); }} onSave={(d) => { setInvoiceDiscount(d); setDialog(null); focusSearch(); }} />
      )}
      {dialog?.kind === 'held' && <HeldDialog onClose={() => { setDialog(null); focusSearch(); }} onResume={async (h) => {
        if (lines.length) { const r = await confirm({ title: 'استعادة فاتورة معلقة', message: 'الفاتورة الحالية سيتم تعليقها أولًا.', confirmText: 'متابعة' }); if (!r.ok) return; await hold(); }
        const held = await api('held.get', { id: h.id });
        await loadCart(held.cart, { heldId: h.id });
        setDialog(null); focusSearch();
      }} />}
      {dialog?.kind === 'cash' && <CashDialog onClose={() => { setDialog(null); focusSearch(); }} />}
      {dialog?.kind === 'quote' && <QuoteDialog cart={cartPayload()} customerName={customer?.name} onClose={() => setDialog(null)} onDone={() => { setDialog(null); resetSale(); }} />}
      {dialog?.kind === 'pay' && priced && (
        <PayDialog priced={priced} customer={customer} onClose={() => { setDialog(null); focusSearch(); }} cart={cartPayload()} heldId={heldId} quotationId={quotationId}
          onPickCustomer={() => setDialog({ kind: 'customer' })}
          onDone={(sale) => {
            // a sale changes stock, cash, dashboard and reports: refresh everything cached
            void qc.invalidateQueries();
            resetSale();
            setDialog({ kind: 'receipt', data: sale });
          }} />
      )}
      {dialog?.kind === 'receipt' && <ReceiptDialog sale={dialog.data} autoPrint={settings['print.autoPrint']} onClose={() => { setDialog(null); focusSearch(); }} />}
      <div className="no-print" style={{ position: 'fixed', bottom: 4, right: 250, fontSize: 11, opacity: .55 }}>{user?.fullName}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ open shift */
function OpenShift({ onOpened }: { onOpened: () => void }) {
  const [cash, setCash] = useState<number | null>(0);
  const { run, busy } = useAction();
  return (
    <div className="content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card pad" style={{ width: 420 }}>
        <div className="row mb"><Lock color="var(--primary)" /><h2>فتح الوردية</h2></div>
        <p className="muted small">قبل البيع، اكتب النقدية الموجودة في الدرج الآن (الفكة). في نهاية الوردية سيقارن البرنامج النقدية المتوقعة بالفعلية.</p>
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('shifts.open', { openingCash: cash ?? 0 }); onOpened(); }, 'تم فتح الوردية'); }} className="col">
          <Field label="الرصيد الافتتاحي في الدرج"><MoneyInput className="lg" autoFocus value={cash} onChange={setCash} /></Field>
          <button className="btn primary lg" disabled={busy}>فتح الوردية وبدء البيع</button>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ weight */
function WeightDialog({ product, onClose, onAdd }: { product: PProduct; onClose: () => void; onAdd: (unitId: number, qtyMilli: number) => void }) {
  const base = product.units.find((u) => u.unit_id === product.base_unit_id)!;
  const sub = product.units.find((u) => u.factor < 1000 && u.allow_decimal); // e.g. gram
  const perBase = unitPriceOf(product, base);
  const [mode, setMode] = useState<'sub' | 'base' | 'amount'>(sub ? 'sub' : 'base');
  const [val, setVal] = useState<number | null>(null);
  // base milli for the entered value
  // sub mode: val is a plain count of sub-units (e.g. 250 grams); factor = base milli per 1 sub-unit
  const baseMilli = val === null || val <= 0 ? 0 : mode === 'sub' && sub ? Math.round(val * sub.factor) : mode === 'base' ? val : Math.round((val * 1000) / perBase);
  const amount = Math.round((perBase * baseMilli) / 1000);
  const submit = () => {
    if (baseMilli <= 0) return;
    if (sub && (mode === 'sub' || baseMilli < 1000)) onAdd(sub.unit_id, Math.round((baseMilli * 1000) / sub.factor));
    else onAdd(base.unit_id, baseMilli);
  };
  const quick = sub ? [100, 125, 250, 500, 750, 1000] : [];
  return (
    <Modal title={<><Scale size={18} /> {fullName(product)} — {money(perBase)} / {base.unit_symbol}</>} onClose={onClose} size="sm"
      footer={<><button className="btn" onClick={onClose}>إلغاء</button><button className="btn primary lg" disabled={baseMilli <= 0} onClick={submit}>إضافة {money(amount)}</button></>}>
      <form className="col" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Segmented value={mode} onChange={(m) => { setMode(m); setVal(null); }} options={[
          ...(sub ? [{ value: 'sub' as const, label: `بال${sub.unit_name}` }] : []),
          { value: 'base' as const, label: `بال${base.unit_name}` },
          { value: 'amount' as const, label: 'بمبلغ' },
        ]} />
        {mode === 'sub' ? (
          <Field label={`الوزن (${sub!.unit_symbol})`}><NumberInput className="lg" autoFocus value={val} onChange={setVal} suffix={sub!.unit_symbol} /></Field>
        ) : mode === 'base' ? (
          <Field label={`الكمية (${base.unit_symbol})`}><QtyInput className="lg" autoFocus value={val} onChange={setVal} suffix={base.unit_symbol} /></Field>
        ) : (
          <Field label="المبلغ المطلوب" help="مثال: العميل يريد جبنة بـ 50 جنيه"><MoneyInput className="lg" autoFocus value={val} onChange={setVal} /></Field>
        )}
        {mode === 'sub' && <div className="row wrap gap-sm">{quick.map((g) => <button type="button" key={g} className="btn sm" onClick={() => setVal(g)}>{g} {sub!.unit_symbol}</button>)}</div>}
        <div className="alert info"><b>{fmtQty(baseMilli)} {base.unit_symbol}</b> × {money(perBase)} = <b className="num">{money(amount)}</b></div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ line edit */
function LineDialog({ line, priced, focus, onClose, onSave, onRemove }: { line: Line; priced?: PricedLine; focus?: 'qty' | 'discount'; onClose: () => void; onSave: (p: Partial<Line>) => void; onRemove: () => void }) {
  const { can } = useApp();
  const [unitId, setUnitId] = useState(line.unitId);
  const [q, setQ] = useState<number | null>(line.qty);
  const unit = line.product.units.find((u) => u.unit_id === unitId)!;
  const list = unitPriceOf(line.product, unit);
  const [price, setPrice] = useState<number | null>(line.unitPrice ?? (unitId === line.unitId ? priced?.listPrice ?? list : list));
  const [dType, setDType] = useState<'amount' | 'percent'>(line.discount?.type ?? 'amount');
  const [dVal, setDVal] = useState<number | null>(line.discount ? (line.discount.type === 'amount' ? line.discount.value : line.discount.value * 100) : null);
  const canPrice = can('pos.price_override');
  const gross = Math.round(((price ?? 0) * (q ?? 0)) / 1000);
  const submit = () => {
    if (!q || q <= 0) return;
    const disc: Discount | null = dVal && dVal > 0 ? { type: dType, value: dType === 'amount' ? dVal : dVal / 100 } : null;
    onSave({ unitId, qty: q, unitPrice: price !== null && price !== list ? price : null, discount: disc });
  };
  return (
    <Modal title={fullName(line.product)} onClose={onClose}
      footer={<><button className="btn danger outline" onClick={onRemove}><Trash2 size={15} /> حذف الصنف</button><div className="grow" /><button className="btn" onClick={onClose}>إلغاء</button><button className="btn primary" onClick={submit}>حفظ</button></>}>
      <form className="col" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="grid grid-2">
          <Field label="الكمية"><QtyInput className="lg" autoFocus={focus !== 'discount'} value={q} onChange={setQ} suffix={unit.unit_symbol} /></Field>
          {line.product.units.length > 1 && (
            <Field label="الوحدة">
              <select className="select" style={{ height: 48 }} value={unitId} onChange={(e) => { const id = Number(e.target.value); setUnitId(id); const u = line.product.units.find((x) => x.unit_id === id)!; setPrice(unitPriceOf(line.product, u)); }}>
                {line.product.units.map((u) => <option key={u.unit_id} value={u.unit_id}>{u.unit_name}{u.factor !== 1000 ? ` (${fmtQty(u.factor)})` : ''} — {money(unitPriceOf(line.product, u))}</option>)}
              </select>
            </Field>
          )}
        </div>
        <Field label={`سعر ${unit.unit_name}`} help={canPrice ? `السعر الأصلي: ${money(list)}` : 'تعديل السعر يحتاج صلاحية أو موافقة مدير عند الدفع'}>
          <MoneyInput value={price} onChange={setPrice} />
        </Field>
        {line.product.allow_discount ? (
          <Field label="خصم على الصنف">
            <div className="row">
              <Segmented value={dType} onChange={setDType} options={[{ value: 'amount', label: 'مبلغ' }, { value: 'percent', label: 'نسبة %' }]} />
              <NumberInput autoFocus={focus === 'discount'} value={dVal} allowEmpty onChange={setDVal} suffix={dType === 'percent' ? '%' : undefined} placeholder="0" />
            </div>
          </Field>
        ) : <div className="muted small">هذا المنتج لا يقبل خصمًا.</div>}
        <div className="alert info">إجمالي الصنف قبل الخصم: <b className="num">{money(gross)}</b></div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function DiscountDialog({ title, base, value, onClose, onSave }: { title: string; base: number; value: Discount | null; onClose: () => void; onSave: (d: Discount | null) => void }) {
  const [type, setType] = useState<'amount' | 'percent'>(value?.type ?? 'amount');
  const [v, setV] = useState<number | null>(value ? (value.type === 'amount' ? value.value : value.value * 100) : null);
  const amount = !v ? 0 : type === 'amount' ? Math.min(v, base) : Math.round((base * Math.min(v / 100, 100)) / 100);
  const save = () => onSave(v && v > 0 ? { type, value: type === 'amount' ? v : v / 100 } : null);
  return (
    <Modal title={title} size="sm" onClose={onClose} footer={<><button className="btn" onClick={() => onSave(null)}>إزالة الخصم</button><div className="grow" /><button className="btn primary" onClick={save}>تطبيق</button></>}>
      <form className="col" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Segmented value={type} onChange={(t) => { setType(t); setV(null); }} options={[{ value: 'amount', label: 'مبلغ' }, { value: 'percent', label: 'نسبة %' }]} />
        {type === 'amount' ? <MoneyInput className="lg" autoFocus value={v} onChange={setV} allowEmpty /> : <NumberInput className="lg" autoFocus value={v} onChange={setV} allowEmpty suffix="%" />}
        <div className="row wrap gap-sm">{(type === 'percent' ? [5, 10, 15, 20] : []).map((p) => <button type="button" key={p} className="btn sm" onClick={() => setV(p * 100)}>{p}%</button>)}</div>
        <div className="alert info">قيمة الخصم: <b className="num">{money(amount)}</b> من {money(base)}</div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ customer */
export function CustomerDialog({ onClose, onPick }: { onClose: () => void; onPick: (c: { id: number; name: string; balance: number; phone?: string }) => void }) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const { run, busy } = useAction();
  const list = useQuery({ queryKey: ['customers', 'pick'], queryFn: () => api<any[]>('customers.list', {}) });
  const nq = normalizeArabic(q);
  const rows = (list.data ?? []).filter((c) => !nq || normalizeArabic(`${c.name} ${c.phone ?? ''}`).includes(nq)).slice(0, 50);
  return (
    <Modal title="اختيار عميل" onClose={onClose}>
      {!adding ? (
        <div className="col">
          <div className="row">
            <input className="input" autoFocus placeholder="بحث بالاسم أو الهاتف" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn" onClick={() => { setAdding(true); setName(q); }}><UserPlus size={15} /> عميل جديد</button>
          </div>
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="table"><tbody>
              {rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => onPick({ id: c.id, name: c.name, balance: c.balance, phone: c.phone })}>
                  <td className="bold">{c.name}</td><td className="num muted">{c.phone}</td>
                  <td className="n">{c.balance > 0 ? <span className="danger-text">عليه {money(c.balance)}</span> : c.balance < 0 ? <span className="success-text">له {money(-c.balance)}</span> : '—'}</td>
                </tr>
              ))}
            </tbody></table>
            {!rows.length && <Empty title="لا يوجد عملاء" />}
          </div>
        </div>
      ) : (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api('customers.save', { data: { name, phone } }); onPick({ id: r.id, name, balance: 0, phone }); }); }}>
          <Field label="اسم العميل"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="الهاتف"><input className="input" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <div className="row"><button type="button" className="btn" onClick={() => setAdding(false)}>رجوع</button><button className="btn primary" disabled={busy || !name.trim()}>حفظ واختيار</button></div>
        </form>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ held */
function HeldDialog({ onClose, onResume }: { onClose: () => void; onResume: (h: any) => void }) {
  const held = useQuery({ queryKey: ['held'], queryFn: () => api<any[]>('held.list') });
  const qc = useQueryClient();
  const { run } = useAction();
  return (
    <Modal title="الفواتير المعلقة" onClose={onClose} size="lg">
      {!held.data?.length ? <Empty title="لا توجد فواتير معلقة" /> : (
        <table className="table"><thead><tr><th>الوقت</th><th>العميل</th><th>الكاشير</th><th className="n">الأصناف</th><th className="n">الإجمالي</th><th /></tr></thead>
          <tbody>{held.data.map((h) => (
            <tr key={h.id}>
              <td className="num">{dateTime(h.created_at)}</td><td>{h.customer_name ?? h.label ?? '—'}</td><td>{h.user_name}</td><td className="n">{h.items_count}</td><td className="n bold">{money(h.total)}</td>
              <td className="row gap-sm" style={{ justifyContent: 'flex-end' }}>
                <button className="btn sm primary" onClick={() => onResume(h)}>استعادة</button>
                <button className="btn sm ghost" onClick={() => run(async () => { await api('held.delete', { id: h.id }); await qc.invalidateQueries({ queryKey: ['held'] }); })}><Trash2 size={14} /></button>
              </td>
            </tr>
          ))}</tbody></table>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ drawer cash in/out */
function CashDialog({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<'withdrawal' | 'deposit'>('withdrawal');
  const [amount, setAmount] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  const qc = useQueryClient();
  return (
    <Modal title="حركة نقدية في الدرج" size="sm" onClose={onClose}
      footer={<button className="btn primary" disabled={busy || !amount} onClick={() => run(async () => { await api('shifts.cash', { type, amount, note }); await qc.invalidateQueries({ queryKey: ['shift'] }); onClose(); }, 'تم تسجيل الحركة')}>تسجيل</button>}>
      <div className="col">
        <Segmented value={type} onChange={setType} options={[{ value: 'withdrawal', label: 'سحب من الدرج' }, { value: 'deposit', label: 'إضافة للدرج' }]} />
        <Field label="المبلغ"><MoneyInput className="lg" autoFocus value={amount} onChange={setAmount} allowEmpty /></Field>
        <Field label="ملاحظة"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثال: توريد للمالك" /></Field>
      </div>
    </Modal>
  );
}

function QuoteDialog({ cart, customerName, onClose, onDone }: { cart: any; customerName?: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(customerName ?? '');
  const [days, setDays] = useState<number | null>(7);
  const { run, busy } = useAction();
  return (
    <Modal title="حفظ كعرض سعر" size="sm" onClose={onClose} footer={<button className="btn primary" disabled={busy} onClick={() => run(async () => { await api('quotations.create', { cart, customerName: name, validDays: days }); onDone(); }, 'تم حفظ عرض السعر — لم يتأثر المخزون')}>حفظ</button>}>
      <div className="col">
        <div className="alert info">عرض السعر لا يخصم من المخزون ولا يؤثر على الخزنة. يمكن تحويله لفاتورة لاحقًا.</div>
        <Field label="اسم العميل"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="صالح لمدة (يوم)"><NumberInput value={days} onChange={setDays} /></Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ payment */
type PayMethod = 'cash' | 'card' | 'wallet' | 'credit';

function PayDialog({ priced, customer, cart, heldId, quotationId, onClose, onDone, onPickCustomer }: {
  priced: Priced; customer: { id: number; name: string; balance: number } | null; cart: any; heldId: number | null; quotationId: number | null;
  onClose: () => void; onDone: (sale: any) => void; onPickCustomer: () => void;
}) {
  const { can, feature } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const total = priced.total;
  const [method, setMethod] = useState<PayMethod>('cash');
  const [tendered, setTendered] = useState<number | null>(total);
  const [split, setSplit] = useState<{ method: PayMethod; amount: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const clientRef = useRef(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const paidSplit = split.reduce((a, p) => a + p.amount, 0);
  const remaining = total - paidSplit;
  const current = tendered ?? 0;
  const change = method === 'cash' ? Math.max(0, current - remaining) : 0;
  const shortBy = Math.max(0, remaining - current);
  const quick = useMemo(() => {
    const r = Math.max(remaining, 0);
    const notes = [5_000, 10_000, 20_000, 50_000, 100_000, 200_000];
    const set = new Set<number>([r]);
    for (const n of notes) { const v = Math.ceil(r / n) * n; if (v > r) set.add(v); if (set.size >= 5) break; }
    return [...set].slice(0, 5);
  }, [remaining]);

  const methods: { m: PayMethod; label: string; icon: React.ReactNode; hidden?: boolean }[] = [
    { m: 'cash', label: 'نقدي', icon: <Banknote /> },
    { m: 'card', label: 'كارت', icon: <CreditCard /> },
    { m: 'wallet', label: 'محفظة', icon: <Smartphone /> },
    { m: 'credit', label: 'آجل', icon: <User />, hidden: !feature('creditSales') },
  ];

  const finish = async () => {
    if (busy) return;
    let payments = [...split];
    if (method === 'credit') {
      if (!customer) { toast('البيع الآجل يحتاج اختيار عميل', 'error'); onPickCustomer(); return; }
      payments.push({ method: 'credit', amount: Math.max(0, remaining) });
    } else if (current > 0) {
      payments.push({ method, amount: method === 'cash' ? current : Math.min(current, remaining) });
    }
    payments = payments.filter((p) => p.amount > 0 || total === 0);
    const covered = payments.reduce((a, p) => a + p.amount, 0);
    if (covered < total && !customer) { toast('المبلغ المدفوع أقل من الإجمالي. أكمل المبلغ أو اختر عميلًا للبيع الآجل.', 'error'); return; }
    if (covered < total && customer && !(await confirmCredit(total - covered))) return;
    setBusy(true);
    try {
      const sale = await apiApproved('sales.checkout', { cart, payments, heldId, quotationId, clientRef: clientRef.current });
      onDone(sale);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally { setBusy(false); }
  };
  const confirmCredit = async (amount: number) => (await confirm({ title: 'بيع آجل', message: `سيتم تسجيل ${money(amount)} كمديونية على العميل ${customer?.name}. متابعة؟`, confirmText: 'تسجيل آجل' })).ok;

  return (
    <Modal title="الدفع" onClose={onClose} size="lg"
      footer={<>
        <button className="btn lg" onClick={onClose}>رجوع</button>
        <div className="grow" />
        <button className="btn primary xl" disabled={busy} onClick={() => void finish()}>
          {busy ? <span className="spinner" /> : <Printer size={22} />} تأكيد وحفظ الفاتورة <span className="kbd">Enter</span>
        </button>
      </>}>
      <form className="grid grid-2 gap-lg" onSubmit={(e) => { e.preventDefault(); void finish(); }}>
        <div className="col">
          <div className="card pad center">
            <div className="muted">المطلوب</div>
            <div className="big-amount num">{money(remaining)}</div>
            {split.length > 0 && <div className="small muted">إجمالي الفاتورة {money(total)} — مدفوع {money(paidSplit)}</div>}
          </div>
          <div className="methods">
            {methods.filter((x) => !x.hidden).map((x) => (
              <button type="button" key={x.m} className={method === x.m ? 'on' : ''} onClick={() => { setMethod(x.m); setTendered(x.m === 'credit' ? 0 : Math.max(remaining, 0)); }}>{x.icon}{x.label}</button>
            ))}
          </div>
          {customer ? <div className="alert info"><User size={16} /> العميل: <b>{customer.name}</b> {customer.balance > 0 && <span>— عليه حاليًا {money(customer.balance)}</span>}</div>
            : <button type="button" className="btn" onClick={onPickCustomer}><UserPlus size={15} /> إضافة عميل (اختياري)</button>}
          {method === 'credit' && !can('pos.credit_sale') && <div className="alert warning">البيع الآجل يحتاج موافقة مدير.</div>}
        </div>
        <div className="col">
          {method !== 'credit' && (
            <>
              <Field label={method === 'cash' ? 'المبلغ المستلم من العميل' : `المبلغ المدفوع (${METHOD_LABEL[method]})`}>
                <MoneyInput className="lg" autoFocus value={tendered} onChange={setTendered} allowEmpty style={{ fontSize: '1.6rem', height: 58 }} />
              </Field>
              {method === 'cash' && <div className="paypad">{quick.map((v) => <button type="button" key={v} onClick={() => setTendered(v)} className="num">{money(v, false)}</button>)}</div>}
            </>
          )}
          {method === 'cash' && (shortBy > 0
            ? <div className="change-box due"><div>المتبقي</div><div className="big-amount num">{money(shortBy)}</div></div>
            : <div className="change-box"><div>الباقي للعميل</div><div className="big-amount num">{money(change)}</div></div>)}
          {method === 'credit' && <div className="change-box due"><div>سيُسجَّل آجلًا على العميل</div><div className="big-amount num">{money(Math.max(remaining, 0))}</div></div>}
          {method !== 'credit' && shortBy > 0 && current > 0 && (
            <button type="button" className="btn" onClick={() => { setSplit((s) => [...s, { method, amount: current }]); setTendered(Math.max(0, remaining - current)); setMethod(method === 'cash' ? 'card' : 'cash'); }}>
              دفع جزء {METHOD_LABEL[method]} ({money(current)}) وإكمال الباقي بطريقة أخرى
            </button>
          )}
          {split.length > 0 && (
            <div className="card pad small">
              {split.map((p, i) => <div key={i} className="row between"><span>{METHOD_LABEL[p.method]}</span><span className="num">{money(p.amount)}</span><button type="button" className="btn ghost sm icon" onClick={() => setSplit((s) => s.filter((_, j) => j !== i))}><X size={13} /></button></div>)}
            </div>
          )}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ receipt */
export function ReceiptDialog({ sale, autoPrint, onClose }: { sale: any; autoPrint?: boolean; onClose: () => void }) {
  const toast = useToast();
  const [html, setHtml] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const printed = useRef(false);
  const print = useCallback(async (mode: 'print' | 'pdf' = 'print') => {
    setPrinting(true);
    try {
      const r = await api('print.sale', { id: sale.id, mode });
      if (mode === 'print') toast('تم إرسال الفاتورة للطابعة', 'success');
      else if (r.file) toast('تم حفظ الفاتورة PDF', 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setPrinting(false); }
  }, [sale.id, toast]);
  useEffect(() => { api('print.sale', { id: sale.id, mode: 'preview' }).then((r) => setHtml(r.html)).catch(() => setHtml(null)); }, [sale.id]);
  useEffect(() => { if (autoPrint && !printed.current) { printed.current = true; void print('print'); } }, [autoPrint, print]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === 'F1') { e.preventDefault(); onClose(); } if (e.key === 'p' && e.ctrlKey) { e.preventDefault(); void print(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, print]);
  return (
    <Modal title={`تم حفظ الفاتورة رقم ${sale.invoice_no}`} onClose={onClose} size="lg"
      footer={<>
        <button className="btn" onClick={() => void print('pdf')}>حفظ PDF</button>
        <button className="btn lg" disabled={printing} onClick={() => void print('print')}><Printer size={18} /> طباعة <span className="kbd">Ctrl+P</span></button>
        <div className="grow" />
        <button className="btn primary lg" onClick={onClose} autoFocus>فاتورة جديدة <span className="kbd">Enter</span></button>
      </>}>
      <div className="grid grid-2 gap-lg">
        <div className="col">
          <div className="change-box"><div>الإجمالي</div><div className="big-amount num">{money(sale.total)}</div></div>
          {sale.change_due > 0 && <div className="change-box"><div>الباقي للعميل</div><div className="big-amount num">{money(sale.change_due)}</div></div>}
          {sale.credit_amount > 0 && <div className="change-box due"><div>آجل على {sale.customer_name}</div><div className="big-amount num">{money(sale.credit_amount)}</div></div>}
          <div className="small muted">{(sale.payments ?? []).map((p: any) => `${METHOD_LABEL[p.method]}: ${money(p.amount)}`).join(' — ')}</div>
        </div>
        <div>{html ? <iframe title="معاينة الفاتورة" className="receipt-frame" sandbox="" srcDoc={html} /> : <div className="skeleton" style={{ height: 300 }} />}</div>
      </div>
    </Modal>
  );
}
