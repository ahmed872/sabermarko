import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShoppingCart, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { money, qty as fmtQty, todayIso } from '../lib/format';
import { Field, MoneyInput, PageHeader, QtyInput, Switch, useAction, useToast } from '../components/ui';
import { ProductPicker, type PickedProduct } from '../components/ProductPicker';

export interface PLine {
  productId: number; name: string; units: { unit_id: number; unit_name: string; factor: number }[]; unitId: number; qty: number | null; unitCost: number | null;
  discount: number | null; expiryDate: string; batchNo: string; trackExpiry: boolean; sellPrice: number; newSellPrice: number | null; baseSymbol: string; poItemId?: number | null; lastCost: number | null;
}

export async function loadPurchaseLine(productId: number, preferUnitId?: number, qty?: number | null, unitCost?: number | null): Promise<PLine> {
  const p = await api('products.get', { id: productId });
  const units = p.units.map((u: any) => ({ unit_id: u.unit_id, unit_name: u.unit_name, factor: u.factor }));
  const def = preferUnitId ?? p.units.find((u: any) => u.is_default_purchase)?.unit_id ?? p.base_unit_id;
  const factor = units.find((u: any) => u.unit_id === def)?.factor ?? 1000;
  const lastBase = p.last_cost ?? p.avg_cost ?? null;
  return {
    productId, name: p.variant_name ? `${p.name} ${p.variant_name}` : p.name, units, unitId: def, qty: qty ?? null,
    unitCost: unitCost ?? (lastBase !== null ? Math.round((lastBase * factor) / 1000) : null), discount: null, expiryDate: '', batchNo: '', trackExpiry: !!p.track_expiry,
    sellPrice: p.sell_price, newSellPrice: null, baseSymbol: p.unit_symbol, lastCost: lastBase,
  };
}

export default function PurchaseForm() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { feature, can } = useApp();
  const [params] = useSearchParams();
  const { run, busy } = useAction();
  const suppliers = useQuery({ queryKey: ['suppliers', 'pick'], queryFn: () => api<any[]>('suppliers.list', {}) });
  const shift = useQuery({ queryKey: ['shift'], queryFn: () => api('shifts.current') });
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [date, setDate] = useState(todayIso());
  const [lines, setLines] = useState<PLine[]>([]);
  const [discount, setDiscount] = useState<number | null>(null);
  const [tax, setTax] = useState<number | null>(null);
  const [paid, setPaid] = useState<number | null>(null);
  const [method, setMethod] = useState<'cash' | 'card' | 'wallet' | 'bank'>('cash');
  const [fromDrawer, setFromDrawer] = useState(false);
  const [notes, setNotes] = useState('');
  const [poId, setPoId] = useState<number | null>(null);

  useEffect(() => {
    const po = Number(params.get('po'));
    if (po) {
      api('po.receiveDraft', { id: po }).then(async (d) => {
        setPoId(d.poId); setSupplierId(d.supplierId);
        const ls: PLine[] = [];
        for (const l of d.lines) { const pl = await loadPurchaseLine(l.productId, l.unitId, l.qty, l.unitCost); pl.poItemId = l.poItemId; ls.push(pl); }
        setLines(ls);
      }).catch((e) => toast(e.message, 'error'));
    } else if (params.get('fromReorder')) {
      const draft = JSON.parse(sessionStorage.getItem('reorderDraft') ?? '[]') as any[];
      sessionStorage.removeItem('reorderDraft');
      Promise.all(draft.map((r) => loadPurchaseLine(r.productId, r.purchaseUnitId ?? undefined, r.purchaseUnits * 1000))).then(setLines);
      const sup = draft.find((r) => r.supplierId)?.supplierId;
      if (sup) setSupplierId(sup);
    }
  }, [params, toast]);

  const lineTotal = (l: PLine) => Math.max(0, Math.round(((l.unitCost ?? 0) * (l.qty ?? 0)) / 1000) - (l.discount ?? 0));
  const subtotal = lines.reduce((a, l) => a + lineTotal(l), 0);
  const total = Math.max(0, subtotal - (discount ?? 0) + (tax ?? 0));
  const remaining = total - (paid ?? 0);
  const upd = (i: number, p: Partial<PLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const supplier = useMemo(() => suppliers.data?.find((s) => s.id === supplierId), [suppliers.data, supplierId]);

  const add = async (p: PickedProduct) => {
    const existing = lines.findIndex((l) => l.productId === p.id);
    if (existing >= 0) { upd(existing, { qty: (lines[existing].qty ?? 0) + 1000 }); return; }
    setLines([...lines, await loadPurchaseLine(p.id)]);
  };

  const save = () => run(async () => {
    const valid = lines.filter((l) => l.qty && l.qty > 0);
    if (!valid.length) throw new Error('أضف منتجًا واحدًا على الأقل بكمية');
    for (const l of valid) if (feature('expiry') && l.trackExpiry && !l.expiryDate) throw new Error(`حدد تاريخ صلاحية "${l.name}"`);
    if (remaining > 0 && !supplierId) throw new Error('الشراء بالآجل (المتبقي) يحتاج اختيار مورد');
    const res = await api('purchases.create', {
      supplierId: supplierId || null, supplierInvoiceNo: invoiceNo || null, purchaseDate: date, poId,
      lines: valid.map((l) => ({ productId: l.productId, unitId: l.unitId, qty: l.qty, unitCost: l.unitCost ?? 0, discount: l.discount ?? 0, expiryDate: l.expiryDate || null, batchNo: l.batchNo || null, poItemId: l.poItemId ?? null, newSellPrice: l.newSellPrice })),
      discount: discount ?? 0, tax: tax ?? 0, paid: paid ?? 0, paymentMethod: method, paidFromDrawer: method === 'cash' && fromDrawer, notes: notes || null,
    });
    await qc.invalidateQueries();
    toast(`تم حفظ فاتورة الشراء ${res.purchase_no} وإضافة الكميات للمخزون`, 'success');
    nav(`/purchases?open=${res.id}`, { replace: true });
  });

  return (
    <div>
      <PageHeader title={poId ? 'استلام بضاعة من طلب شراء' : 'فاتورة شراء جديدة'} sub="عند الحفظ يزيد المخزون وتتحدث تكلفة المنتجات تلقائيًا" icon={<ShoppingCart color="var(--primary)" />} />
      <div className="col gap-lg">
        <div className="card pad">
          <div className="form-grid">
            <Field label="المورد" help={supplier ? `الرصيد الحالي المستحق له: ${money(supplier.balance)}` : 'اختياري للشراء النقدي'}>
              <select className="select" value={supplierId} onChange={(e) => setSupplierId(Number(e.target.value) || '')} disabled={!!poId}>
                <option value="">بدون مورد (شراء نقدي)</option>{(suppliers.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}{s.company ? ` — ${s.company}` : ''}</option>)}
              </select>
            </Field>
            <Field label="رقم فاتورة المورد"><input className="input" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></Field>
            <Field label="تاريخ الفاتورة"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
        </div>
        <div className="card">
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}><ProductPicker autoFocus onPick={(p) => void add(p)} /></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>المنتج</th><th style={{ width: 150 }}>الوحدة</th><th style={{ width: 120 }}>الكمية</th><th style={{ width: 130 }}>سعر الشراء للوحدة</th><th style={{ width: 110 }}>خصم</th>{feature('expiry') && <th style={{ width: 150 }}>الصلاحية</th>}{can('products.edit_price') && <th style={{ width: 130 }}>سعر البيع الجديد</th>}<th className="n">الإجمالي</th><th /></tr></thead>
              <tbody>{lines.map((l, i) => {
                const u = l.units.find((x) => x.unit_id === l.unitId);
                const baseCost = l.unitCost !== null && u ? (l.unitCost * 1000) / u.factor : null;
                return (
                  <tr key={i}>
                    <td><div className="bold">{l.name}</div><div className="xs muted">{u && u.factor !== 1000 ? `${fmtQty(l.qty ?? 0)} × ${fmtQty(u.factor)} = ${fmtQty(Math.round(((l.qty ?? 0) * u.factor) / 1000))} ${l.baseSymbol}` : ''}{baseCost !== null && l.lastCost !== null && Math.abs(baseCost - l.lastCost) > 1 ? <span className={baseCost > l.lastCost ? 'danger-text' : 'success-text'}> • السعر السابق {money(Math.round((l.lastCost * (u?.factor ?? 1000)) / 1000))}</span> : null}</div></td>
                    <td><select className="select" value={l.unitId} onChange={(e) => { const nu = Number(e.target.value); const f = l.units.find((x) => x.unit_id === nu)!.factor; upd(i, { unitId: nu, unitCost: baseCost !== null ? Math.round((baseCost * f) / 1000) : l.unitCost }); }}>{l.units.map((x) => <option key={x.unit_id} value={x.unit_id}>{x.unit_name}{x.factor !== 1000 ? ` (${fmtQty(x.factor)})` : ''}</option>)}</select></td>
                    <td><QtyInput value={l.qty} allowEmpty onChange={(v) => upd(i, { qty: v })} /></td>
                    <td><MoneyInput value={l.unitCost} allowEmpty onChange={(v) => upd(i, { unitCost: v })} /></td>
                    <td><MoneyInput value={l.discount} allowEmpty onChange={(v) => upd(i, { discount: v })} /></td>
                    {feature('expiry') && <td>{l.trackExpiry ? <input type="date" className="input" value={l.expiryDate} onChange={(e) => upd(i, { expiryDate: e.target.value })} /> : <span className="muted xs">—</span>}</td>}
                    {can('products.edit_price') && <td><MoneyInput value={l.newSellPrice} allowEmpty placeholder={money(l.sellPrice, false)} onChange={(v) => upd(i, { newSellPrice: v })} /></td>}
                    <td className="n bold">{money(lineTotal(l))}</td>
                    <td><button className="btn ghost sm icon" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
                  </tr>
                );
              })}</tbody>
            </table>
            {!lines.length && <div className="empty"><div className="t">ابحث عن المنتجات وأضفها للفاتورة</div><div className="d">يمكنك الشراء بالكرتونة وسيتحول للمخزون بالقطعة تلقائيًا.</div></div>}
          </div>
        </div>
        <div className="grid grid-2">
          <div className="card pad col">
            <Field label="ملاحظات"><textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </div>
          <div className="card pad col">
            <div className="row between"><span>إجمالي الأصناف</span><b className="num">{money(subtotal)}</b></div>
            <div className="row between"><span>خصم على الفاتورة</span><div style={{ width: 160 }}><MoneyInput value={discount} allowEmpty onChange={setDiscount} /></div></div>
            <div className="row between"><span>ضريبة / مصاريف إضافية</span><div style={{ width: 160 }}><MoneyInput value={tax} allowEmpty onChange={setTax} /></div></div>
            <div className="row between" style={{ fontSize: '1.3rem' }}><b>الإجمالي</b><b className="num">{money(total)}</b></div>
            <div className="row between"><span>المدفوع الآن</span>
              <div className="row" style={{ width: 300 }}>
                <select className="select" style={{ width: 110 }} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}><option value="cash">نقدي</option><option value="bank">تحويل</option><option value="card">كارت</option><option value="wallet">محفظة</option></select>
                <MoneyInput value={paid} allowEmpty onChange={setPaid} />
                <button className="btn sm" onClick={() => setPaid(total)}>الكل</button>
              </div>
            </div>
            {method === 'cash' && (paid ?? 0) > 0 && (
              <div className="row between small"><span>صرف المبلغ من درج الكاشير {shift.data ? `(المتاح ${money(shift.data.expected)})` : '(لا توجد وردية مفتوحة)'}</span><Switch checked={fromDrawer} disabled={!shift.data} onChange={setFromDrawer} /></div>
            )}
            <div className={`row between ${remaining > 0 ? 'danger-text' : ''}`}><b>المتبقي {remaining > 0 ? '(يُضاف لحساب المورد)' : ''}</b><b className="num">{money(remaining)}</b></div>
            <button className="btn primary lg" disabled={busy || !lines.length} onClick={save}>حفظ فاتورة الشراء</button>
          </div>
        </div>
      </div>
    </div>
  );
}
