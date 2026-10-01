import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Lightbulb, RefreshCw, Sparkles, ThumbsDown, XCircle } from 'lucide-react';
import { api, apiApproved } from '../lib/api';
import { useApp } from '../lib/app';
import { dateOnly, daysAgo, money, num, pct, qty, todayIso, addDaysIso } from '../lib/format';
import { Empty, Field, Loading, Modal, MoneyInput, NumberInput, PageHeader, QtyInput, Segmented, Stat, Tabs, useAction, useConfirm } from '../components/ui';

const CLASS_LABELS: Record<string, string> = { hot: 'عليه سحب قوي', stable: 'مستقر', slow: 'حركته ضعيفة', dead: 'بضاعة راكدة', excess: 'مخزون زائد', expiry: 'معرض للانتهاء', new: 'جديد' };
const CLASS_ICON: Record<string, string> = { hot: '🔥', stable: '🟢', slow: '🟡', dead: '🔴', excess: '⚠️', expiry: '⏳', new: '🆕' };
const CLASS_TONE: Record<string, string> = { hot: 'success', stable: '', slow: 'warning', dead: 'danger', excess: 'warning', expiry: 'danger', new: 'info' };
const VERDICT_TONE: Record<string, string> = { good: 'success', ok: 'info', review: 'warning' };

/** Dashboard block: "ماذا يحتاج المحل هذا الشهر؟" (3–5 items only). */
export function MonthlyFocus({ compact }: { compact?: boolean }) {
  const { can } = useApp();
  const f = useQuery({ queryKey: ['intelFocus'], queryFn: () => api<any[]>('intel.focus'), enabled: can('reports.view'), staleTime: 300_000 });
  if (!can('reports.view') || !f.data?.length) return null;
  return (
    <div className="card">
      <div className="card-head"><Sparkles size={17} color="var(--primary)" /><h3>ماذا يحتاج المحل هذا الشهر؟</h3><div className="grow" />{compact && <Link to="/insights" className="btn sm">كل الاقتراحات</Link>}</div>
      <div className="card-body attention">
        {f.data.map((i) => (
          <Link key={i.key} to={i.link}><span className="dot info" style={{ fontSize: 16 }}>{i.icon}</span><span className="grow"><b>{i.title}</b> — {i.text}</span></Link>
        ))}
      </div>
    </div>
  );
}

type Tab = 'focus' | 'promos' | 'classes' | 'slow' | 'demand' | 'basket' | 'results' | 'seasonal';

export default function Insights() {
  const { can } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'focus';
  const ov = useQuery({ queryKey: ['intelOverview'], queryFn: () => api('intel.overview') });
  return (
    <div>
      <PageHeader title="اقتراحات البيع" sub="تحليل مبيعاتك ومخزونك: ماذا يتحرك، ماذا يقف، وما العرض المناسب — البرنامج يقترح وأنت تقرر" icon={<Sparkles color="var(--primary)" />} />
      {ov.data && (
        <>
          {ov.data.deadCapital > 0 && <div className="alert warning mb"><AlertTriangle size={18} /> <span>لديك <b>{money(ov.data.deadCapital)}</b> من رأس المال داخل مخزون بطيء الحركة أو راكد أو زائد{ov.data.totalStockValue ? ` (${Math.round((ov.data.deadCapital / ov.data.totalStockValue) * 100)}% من قيمة المخزون)` : ''}.</span></div>}
          {!ov.data.dataSufficient && <div className="alert info mb">البيانات ما زالت قليلة — التصنيفات والاقتراحات تصبح أدق بعد أسبوعين على الأقل من البيع على البرنامج.</div>}
          <div className="grid grid-4 mb">
            <Stat label="🔥 عليه سحب قوي" value={ov.data.counts.hot} />
            <Stat label="🟡 حركته ضعيفة" value={ov.data.counts.slow} />
            <Stat label="🔴 بضاعة راكدة" value={ov.data.counts.dead} hint={ov.data.deadOnlyCapital ? `قيمتها ${money(ov.data.deadOnlyCapital)}` : undefined} />
            <Stat label="⚠️ مخزون زائد / ⏳ صلاحية" value={`${ov.data.counts.excess} / ${ov.data.counts.expiry}`} hint={ov.data.expiryValue ? `معرض للتلف ${money(ov.data.expiryValue)}` : undefined} />
          </div>
        </>
      )}
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[
        { value: 'focus', label: 'ماذا يحتاج المحل' }, { value: 'promos', label: 'العروض المقترحة', hidden: !can('reports.cost') }, { value: 'classes', label: 'تصنيف المنتجات' },
        { value: 'slow', label: 'المخزون البطيء' }, { value: 'demand', label: 'الأكثر طلبًا' }, { value: 'basket', label: 'تُشترى معًا' },
        { value: 'results', label: 'نتائج العروض', hidden: !can('reports.cost') }, { value: 'seasonal', label: 'المواسم' },
      ]} />
      {tab === 'focus' && <div className="col gap-lg"><MonthlyFocus /><div className="card pad small muted">كل الأرقام محسوبة من فواتير ومخزون محلك الفعلي خلال آخر {ov.data?.windowDays ?? 30} يوم، والحدود قابلة للتعديل من الإعدادات ← المخزون. لا يتم تغيير أي سعر أو تفعيل أي عرض بدون موافقتك.</div></div>}
      {tab === 'promos' && <PromosTab />}
      {tab === 'classes' && <ClassesTab />}
      {tab === 'slow' && <SlowTab />}
      {tab === 'demand' && <DemandTab />}
      {tab === 'basket' && <BasketTab />}
      {tab === 'results' && <ResultsTab />}
      {tab === 'seasonal' && <SeasonalTab />}
    </div>
  );
}

/* ------------------------------------------------------------------ suggestions */

function PromosTab() {
  const [all, setAll] = useState(false);
  const qc = useQueryClient();
  const { run, busy } = useAction();
  const list = useQuery({ queryKey: ['suggestions', all], queryFn: () => api('intel.suggestions', { all }) });
  const [edit, setEdit] = useState<any | null>(null);
  if (list.isLoading) return <Loading />;
  const items = list.data?.items ?? [];
  const pending = items.filter((s: any) => s.status === 'new');
  const decided = items.filter((s: any) => s.status !== 'new');
  return (
    <div className="col gap-lg">
      <div className="row">
        <span className="muted small">اقتراحات هذا الشهر مرتبة حسب الفائدة المتوقعة. كل عرض محسوب بأسعارك وتكلفتك الحالية.</span>
        <div className="grow" />
        <button className="btn sm" disabled={busy} onClick={() => run(async () => { await api('intel.generate'); await qc.invalidateQueries({ queryKey: ['suggestions'] }); await qc.invalidateQueries({ queryKey: ['intelFocus'] }); }, 'تم تحديث الاقتراحات')}><RefreshCw size={14} /> تحديث التحليل</button>
      </div>
      {!pending.length ? <Empty title="لا توجد اقتراحات عروض حاليًا" desc="عندما يوجد مخزون بطيء أو زائد أو قريب الانتهاء وبيانات كافية، ستظهر الاقتراحات هنا." icon={<Lightbulb size={26} />} /> : pending.map((s: any) => <SuggestionCard key={s.id} s={s} onEdit={() => setEdit(s)} onDone={() => void list.refetch()} />)}
      {!all && (list.data?.total ?? 0) > items.length && <button className="btn" onClick={() => setAll(true)}>عرض كل الاقتراحات ({list.data.total})</button>}
      {decided.length > 0 && (
        <div className="card">
          <div className="card-head"><h3>قرارات هذا الشهر</h3></div>
          <table className="table"><tbody>{decided.map((s: any) => <tr key={s.id}><td>{s.payload.title}</td><td>{s.status === 'approved' ? <span className="badge success">تم الاعتماد</span> : s.status === 'dismissed' ? <span className="badge">تم التجاهل</span> : <span className="badge">مرفوض</span>}</td><td className="small">{s.decided_by_name}</td><td className="small muted">{s.decision_note ?? ''}</td></tr>)}</tbody></table>
        </div>
      )}
      {edit && <ApproveDialog s={edit} onClose={() => { setEdit(null); void list.refetch(); void qc.invalidateQueries({ queryKey: ['intelFocus'] }); }} />}
    </div>
  );
}

function EconomicsTable({ sim }: { sim: any }) {
  return (
    <table className="table" style={{ fontSize: '.88rem' }}>
      <thead><tr><th>لكل عرض (صفقة واحدة)</th><th className="n">قبل العرض</th><th className="n">مع العرض</th></tr></thead>
      <tbody>
        <tr><td>المبلغ الذي يدفعه العميل</td><td className="n">{money(sim.dealRevenueFull)}</td><td className="n">{money(sim.revenueAfter)}</td></tr>
        <tr><td>تكلفة البضاعة</td><td className="n">{money(sim.dealCost)}</td><td className="n">{money(sim.dealCost)}</td></tr>
        <tr><td><b>الربح المتوقع</b></td><td className="n bold">{money(sim.profitBefore)}</td><td className={`n bold ${sim.profitAfter < 0 ? 'danger-text' : ''}`}>{money(sim.profitAfter)}</td></tr>
        <tr><td>هامش الربح</td><td className="n">{pct(sim.marginBeforePct)}</td><td className="n">{pct(sim.marginAfterPct)}</td></tr>
        <tr><td>تكلفة العرض (الخصم/الهدية)</td><td className="n">—</td><td className="n">{money(sim.discount)} ({num(sim.effectiveDiscountPct, 0)}%)</td></tr>
      </tbody>
    </table>
  );
}

function SuggestionCard({ s, onEdit, onDone }: { s: any; onEdit: () => void; onDone: () => void }) {
  const { can } = useApp();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const p = s.payload;
  const sim = p.simulation;
  const reject = async (mode: 'reject' | 'product' | 'kind') => {
    const r = await confirm({ title: mode === 'reject' ? 'رفض الاقتراح' : mode === 'product' ? 'لا تقترح عروضًا لهذا المنتج' : 'لا تقترح هذا النوع من العروض', message: p.title, confirmText: 'تأكيد' });
    if (r.ok) void run(async () => { await api('intel.reject', { id: s.id, muteProduct: mode === 'product', muteKind: mode === 'kind' }); onDone(); });
  };
  return (
    <div className="card">
      <div className="card-head">
        <Lightbulb size={18} color="var(--accent)" /><h3 className="grow">💡 {p.title}</h3>
        <span className={`badge ${VERDICT_TONE[s.verdict]}`}>{p.verdictText}</span>
      </div>
      <div className="card-body grid grid-2 gap-lg">
        <div className="col">
          <div><b>لماذا؟</b><ul className="small" style={{ margin: '6px 0', paddingInlineStart: 18, lineHeight: 1.9 }}>{p.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></div>
          <div className="small"><b>الهدف:</b> {p.goal}</div>
          {p.history && <div className="small muted">📊 {p.history}</div>}
          {sim.warnings.length > 0 && <div className="alert warning small col" style={{ alignItems: 'flex-start' }}>{sim.warnings.map((w: string, i: number) => <div key={i}>{w}</div>)}</div>}
          {p.rejected?.length > 0 && <div className="small muted">تم استبعاد: {p.rejected.map((r: any) => `"${r.title}" — ${r.why.replace('⚠️ ', '')}`).join(' • ')}</div>}
        </div>
        <div className="col">
          <EconomicsTable sim={sim} />
          <div className="small muted">إذا تم تصريف الكمية المستهدفة ({qty(sim.targetQty)}): {num(sim.deals)} عرض، تكلفة العروض {money(sim.promoCostTotal)}، ربح {money(sim.projectedProfit)}، ويتحرر حوالي {money(sim.capitalFreed)} من رأس المال{sim.rewardUsed ? `، ويُستخدم ${qty(sim.rewardUsed)} من المنتج الثاني` : ''}. (تقدير وليس توقعًا مؤكدًا)</div>
        </div>
      </div>
      {can('promotions.approve') && (
        <div className="row wrap" style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
          <button className="btn primary" disabled={busy} onClick={onEdit}><CheckCircle2 size={16} /> اعتماد العرض</button>
          <button className="btn" onClick={onEdit}>تعديل العرض</button>
          <div className="grow" />
          <button className="btn ghost sm" onClick={() => void reject('reject')}><XCircle size={14} /> رفض</button>
          <button className="btn ghost sm" onClick={() => void reject('product')}><ThumbsDown size={14} /> لا تقترح لهذا المنتج</button>
          <button className="btn ghost sm" onClick={() => void reject('kind')}>لا تقترح هذا النوع</button>
        </div>
      )}
    </div>
  );
}

function ApproveDialog({ s, onClose }: { s: any; onClose: () => void }) {
  const { run, busy } = useAction();
  const p0 = s.payload.proposal;
  const [p, setP] = useState<any>({ ...p0 });
  const [name, setName] = useState(s.payload.title);
  const [start, setStart] = useState(todayIso());
  const [end, setEnd] = useState(addDaysIso(todayIso(), (p0.days ?? 21) - 1));
  const [sim, setSim] = useState<any>(s.payload.simulation);
  useEffect(() => {
    const t = setTimeout(() => { void api('intel.simulate', p).then(setSim).catch(() => {}); }, 250);
    return () => clearTimeout(t);
  }, [p]);
  const set = (k: string, v: unknown) => setP((x: any) => ({ ...x, [k]: v }));
  return (
    <Modal title="مراجعة واعتماد العرض" size="xl" onClose={onClose} footer={<>
      <span className="small muted">العرض يبدأ تلقائيًا في شاشة البيع من تاريخ البداية، ويُقاس أداؤه بعد انتهائه.</span><div className="grow" />
      <button className="btn" onClick={onClose}>إلغاء</button>
      <button className={`btn ${sim.unsafe ? 'danger' : 'primary'}`} disabled={busy} onClick={() => run(async () => {
        await apiApproved('intel.approve', { id: s.id, proposal: p, startDate: start, endDate: end, name });
        onClose();
      }, 'تم اعتماد العرض وتفعيله')}>{sim.unsafe ? 'اعتماد رغم التحذير' : 'اعتماد العرض'}</button>
    </>}>
      <div className="grid grid-2 gap-lg">
        <div className="col">
          <Field label="اسم العرض (يظهر للكاشير)"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="grid grid-2"><Field label="من"><input type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} /></Field><Field label="إلى"><input type="date" className="input" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></Field></div>
          {p.type !== 'combo' && <Field label={`كمية المنتج الأساسي في العرض`}><QtyInput value={p.minQty} onChange={(v) => set('minQty', v ?? 1000)} /></Field>}
          {p.type === 'cross' && <>
            <Field label="كمية المنتج الثاني"><QtyInput value={p.rewardQty} onChange={(v) => set('rewardQty', v ?? 1000)} /></Field>
            <Field label="المنتج الثاني"><Segmented value={p.rewardType} onChange={(v) => set('rewardType', v)} options={[{ value: 'free', label: 'مجانًا' }, { value: 'percent', label: 'بخصم نسبة' }]} /></Field>
            {p.rewardType === 'percent' && <Field label="نسبة الخصم على المنتج الثاني %"><NumberInput value={p.value / 100} onChange={(v) => set('value', Math.round((v ?? 0) * 100))} /></Field>}
            <Field label="أقصى عدد مرات في الفاتورة الواحدة" help="يحمي المنتج سريع الحركة من الاستهلاك كهدية"><NumberInput value={p.maxPerInvoice ?? null} allowEmpty onChange={(v) => set('maxPerInvoice', v)} /></Field>
          </>}
          {p.type === 'percent' && <Field label="نسبة الخصم %"><NumberInput value={p.value / 100} onChange={(v) => set('value', Math.round((v ?? 0) * 100))} /></Field>}
          {p.type === 'combo' && <Field label="سعر العرض للمنتجين معًا"><MoneyInput value={p.value} onChange={(v) => set('value', v ?? 0)} /></Field>}
        </div>
        <div className="col">
          <EconomicsTable sim={sim} />
          {sim.warnings.length ? <div className="alert warning small col" style={{ alignItems: 'flex-start' }}>{sim.warnings.map((w: string, i: number) => <div key={i}>{w}</div>)}</div> : <div className="alert success small">العرض يحافظ على الربح ضمن الحدود المسموحة ✓</div>}
          {sim.unsafe && <div className="small muted">الاعتماد رغم التحذير يحتاج صلاحية "اعتماد عرض رغم تحذير الربحية" أو موافقة مدير، ويُسجل في سجل العمليات.</div>}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ analysis tabs */

function ClassesTab() {
  const [cls, setCls] = useState<string>('');
  const r = useQuery({ queryKey: ['intelProducts', cls], queryFn: () => api<any[]>('intel.products', { cls: cls || null, sort: 'value' }) });
  const { can } = useApp();
  return (
    <div className="card">
      <div className="cats" style={{ borderRadius: 'var(--radius) var(--radius) 0 0' }}>
        <button className={!cls ? 'on' : ''} onClick={() => setCls('')}>الكل</button>
        {Object.keys(CLASS_LABELS).map((k) => <button key={k} className={cls === k ? 'on' : ''} onClick={() => setCls(k)}>{CLASS_ICON[k]} {CLASS_LABELS[k]}</button>)}
      </div>
      {r.isLoading ? <Loading /> : !r.data?.length ? <Empty title="لا توجد منتجات في هذا التصنيف" /> : (
        <div className="table-wrap" style={{ maxHeight: 620 }}><table className="table">
          <thead><tr><th>المنتج</th><th>التصنيف</th><th className="n">المخزون</th><th className="n">البيع اليومي</th><th className="n">يكفي</th>{can('reports.cost') && <th className="n">قيمة المخزون</th>}<th>آخر بيع</th><th>السبب</th></tr></thead>
          <tbody>{r.data.map((m) => (
            <tr key={m.id}><td className="bold"><Link to={`/products/${m.id}`}>{m.name}</Link></td>
              <td>{m.classes.map((c: string) => <span key={c} className={`badge ${CLASS_TONE[c]}`} style={{ marginInlineEnd: 4 }}>{CLASS_ICON[c]} {CLASS_LABELS[c]}</span>)}</td>
              <td className="n">{qty(m.stock)} {m.unitSymbol}</td><td className="n">{qty(Math.round(m.velocity))}</td>
              <td className="n">{m.daysCover === null ? (m.stock > 0 ? '∞' : '—') : `${Math.round(m.daysCover)} يوم`}</td>
              {can('reports.cost') && <td className="n">{money(m.stockValue)}</td>}<td className="small">{daysAgo(m.lastSale)}</td><td className="xs muted" style={{ maxWidth: 320 }}>{m.reasons[0] ?? ''}</td></tr>
          ))}</tbody></table></div>
      )}
    </div>
  );
}

function SlowTab() {
  const { can } = useApp();
  const r = useQuery({ queryKey: ['intelSlow'], queryFn: async () => {
    const rows = await api<any[]>('intel.products', { sort: 'cover' });
    return rows.filter((m) => m.stock > 0 && m.classes.some((c: string) => ['slow', 'dead', 'excess'].includes(c)));
  } });
  const total = (r.data ?? []).reduce((a, m) => a + (m.stockValue ?? 0), 0);
  return (
    <div className="col gap-lg">
      {can('reports.cost') && r.data?.length ? <div className="alert warning">أنت حابس حوالي <b>{money(total)}</b> في {r.data.length} منتج حركتها ضعيفة.</div> : null}
      <div className="card">
        {!r.data?.length ? <Empty title="لا يوجد مخزون بطيء الحركة 👍" /> : (
          <table className="table"><thead><tr><th>المنتج</th><th className="n">المخزون</th><th className="n">متوسط البيع اليومي</th><th className="n">أيام التغطية</th><th>آخر بيع</th>{can('reports.cost') && <th className="n">القيمة</th>}<th /></tr></thead>
            <tbody>{r.data.map((m) => (
              <tr key={m.id}><td className="bold"><Link to={`/products/${m.id}`}>{m.name}</Link></td><td className="n">{qty(m.stock)} {m.unitSymbol}</td><td className="n">{qty(Math.round(m.velocity))}</td>
                <td className="n bold">{m.daysCover === null ? '—' : `${Math.round(m.daysCover)} يوم`}</td><td className="small">{daysAgo(m.lastSale)}</td>{can('reports.cost') && <td className="n">{money(m.stockValue)}</td>}
                <td>{m.classes.filter((c: string) => ['slow', 'dead', 'excess'].includes(c)).map((c: string) => <span key={c} className={`badge ${CLASS_TONE[c]}`}>{CLASS_LABELS[c]}</span>)}</td></tr>
            ))}</tbody></table>
        )}
      </div>
    </div>
  );
}

function DemandTab() {
  const { can } = useApp();
  const r = useQuery({ queryKey: ['intelDemand'], queryFn: () => api('intel.demand') });
  if (!r.data) return <Loading />;
  const block = (title: string, rows: any[], val: (m: any) => string) => (
    <div className="card"><div className="card-head"><h3>{title}</h3></div>
      {!rows.length ? <Empty title="لا توجد مبيعات بعد" /> : <table className="table"><tbody>{rows.map((m, i) => <tr key={m.id}><td className="muted">{i + 1}</td><td className="bold"><Link to={`/products/${m.id}`}>{m.name}</Link></td><td className="n">{val(m)}</td></tr>)}</tbody></table>}
    </div>
  );
  return (
    <div className="grid grid-2">
      {block('🔥 الأكثر مبيعًا (متوسط يومي)', r.data.byQty, (m) => `${qty(Math.round(m.velocity))} ${m.unitSymbol} / يوم`)}
      {block('🧾 الأكثر ظهورًا في الفواتير', r.data.byInvoices, (m) => `${m.invoices} فاتورة`)}
      {block('🔄 الأسرع دورانًا', r.data.byTurnover, (m) => `${num(m.turnover, 1)} مرة / سنة`)}
      {can('reports.cost') && block('💰 الأكثر تحقيقًا للربح', r.data.byProfit, (m) => money(m.profit))}
    </div>
  );
}

function BasketTab() {
  const r = useQuery({ queryKey: ['intelBasket'], queryFn: () => api('intel.basket') });
  if (!r.data) return <Loading />;
  if (!r.data.sufficient) return <div className="alert info">لا توجد بيانات كافية لاقتراح منتجات تُشترى معًا بشكل موثوق (يلزم {r.data.minInvoices} فاتورة على الأقل خلال 90 يوم — لديك {r.data.invoices}).</div>;
  return (
    <div className="card">
      {!r.data.pairs.length ? <Empty title="لم تظهر علاقة واضحة بين المنتجات" desc="لا يوجد منتجان يُشتريان معًا بشكل متكرر أكثر من الصدفة." /> : (
        <table className="table"><thead><tr><th>المنتج</th><th>يُشترى معه</th><th className="n">فواتير مشتركة</th><th className="n">من يشتري الأول يشتري الثاني</th><th className="n">قوة العلاقة</th></tr></thead>
          <tbody>{r.data.pairs.map((p: any) => <tr key={`${p.a}-${p.b}`}><td className="bold">{p.aName}</td><td className="bold">{p.bName}</td><td className="n">{p.both}</td><td className="n">{pct(p.confAB * 100)}</td><td className="n">{num(p.lift, 1)}×</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

function ResultsTab() {
  const r = useQuery({ queryKey: ['intelResults'], queryFn: () => api<any[]>('intel.results') });
  if (!r.data) return <Loading />;
  if (!r.data.length) return <Empty title="لا توجد عروض لقياس نتائجها بعد" desc="بعد اعتماد عرض وانتهاء جزء من مدته ستظهر هنا المقارنة قبل/أثناء العرض." />;
  return (
    <div className="col gap-lg">
      {r.data.map((x: any) => (
        <div key={x.promotion.id} className="card">
          <div className="card-head"><h3 className="grow">{x.promotion.name}</h3>{x.status === 'scheduled' ? <span className="badge info">لم يبدأ</span> : <span className={`badge ${x.status === 'running' ? 'info' : ''}`}>{x.status === 'running' ? 'جارٍ' : 'انتهى'}</span>}</div>
          {x.status === 'scheduled' ? <div className="card-body small muted">يبدأ {dateOnly(x.promotion.start_date)}</div> : (
            <div className="card-body col">
              <div className="small muted">{dateOnly(x.start)} ← {dateOnly(x.end)} ({x.days} يوم) — مقارنة بنفس عدد الأيام قبل العرض</div>
              <table className="table"><thead><tr><th /><th className="n">قبل العرض</th><th className="n">أثناء العرض</th><th className="n">التغير</th></tr></thead>
                <tbody>
                  <tr><td>الكمية المباعة ({x.promotion.product_name})</td><td className="n">{qty(x.mainBefore.units)}</td><td className="n">{qty(x.mainDuring.units)}</td><td className="n">{pct(x.unitsUpliftPct)}</td></tr>
                  <tr><td>الإيراد</td><td className="n">{money(x.before.revenue)}</td><td className="n">{money(x.during.revenue)}</td><td /></tr>
                  <tr><td>مجمل الربح</td><td className="n">{money(x.before.profit)}</td><td className="n">{money(x.during.profit)}</td><td className="n">{pct(x.gpChangePct)}</td></tr>
                  <tr><td>هامش الربح</td><td className="n">{pct(x.marginBefore)}</td><td className="n">{pct(x.marginDuring)}</td><td /></tr>
                  <tr><td>المخزون</td><td className="n">{qty(x.stockStart)}</td><td className="n">{qty(x.stockNow)}</td><td className="n">{x.stockReductionPct !== null ? `-${num(x.stockReductionPct, 0)}%` : '—'}</td></tr>
                </tbody></table>
              <div className="small">استُخدم العرض في {x.uses} فاتورة بإجمالي خصم {money(x.discountGiven)}.</div>
              <div className={`alert ${x.verdict === 'success' || x.verdict === 'clearance' ? 'success' : x.verdict === 'mixed' ? 'warning' : 'info'}`}>{x.text}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SeasonalTab() {
  const r = useQuery({ queryKey: ['intelSeasonal'], queryFn: () => api('intel.seasonal') });
  if (!r.data) return <Loading />;
  if (!r.data.sufficient) return <div className="alert info">اكتشاف المواسم يحتاج سنة كاملة على الأقل من المبيعات على البرنامج (لديك {r.data.historyDays} يوم). لن يعرض البرنامج توقعات غير مبنية على بيانات كافية.</div>;
  return !r.data.items.length ? <Empty title="لا توجد مؤشرات موسمية للفترة القادمة" /> : (
    <div className="card"><table className="table"><tbody>{r.data.items.map((i: any) => <tr key={i.id}><td className="bold"><Link to={`/products/${i.id}`}>{i.name}</Link></td><td className="small">💡 {i.text}</td></tr>)}</tbody></table></div>
  );
}
