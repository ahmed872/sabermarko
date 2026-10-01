import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { BarChart3, Printer } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { dateOnly, daysAgo, money, num, pct, qty } from '../lib/format';
import { DateRangePicker, Empty, Loading, PageHeader, Segmented, Stat, Tabs, presetRange, type Range } from '../components/ui';
import { BarChart } from '../components/Charts';
import { summaryRows } from './DayClose';

type Tab = 'summary' | 'products' | 'categories' | 'cashiers' | 'inventory' | 'dead' | 'purchases' | 'debts';

export default function Reports() {
  const { can } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'summary';
  const [range, setRange] = useState<Range>(presetRange('month'));
  const showRange = !['inventory', 'dead', 'debts'].includes(tab);
  return (
    <div>
      <PageHeader title="التقارير والتحليلات" icon={<BarChart3 color="var(--primary)" />} actions={showRange && <DateRangePicker value={range} onChange={setRange} presets={['today', 'yesterday', 'week', 'month', 'lastMonth', '30']} />} />
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[
        { value: 'summary', label: 'المبيعات والأرباح' }, { value: 'products', label: 'المنتجات' }, { value: 'categories', label: 'التصنيفات' },
        { value: 'cashiers', label: 'الكاشير', hidden: !can('sales.view_all') }, { value: 'inventory', label: 'قيمة المخزون' }, { value: 'dead', label: 'البضاعة الراكدة' },
        { value: 'purchases', label: 'المشتريات', hidden: !can('purchases.view') }, { value: 'debts', label: 'المديونيات' },
      ]} />
      {tab === 'summary' && <SummaryTab range={range} />}
      {tab === 'products' && <ProductsTab range={range} />}
      {tab === 'categories' && <CategoriesTab range={range} />}
      {tab === 'cashiers' && <CashiersTab range={range} />}
      {tab === 'inventory' && <ValuationTab />}
      {tab === 'dead' && <DeadTab />}
      {tab === 'purchases' && <PurchasesTab range={range} />}
      {tab === 'debts' && <DebtsTab />}
    </div>
  );
}

function SummaryTab({ range }: { range: Range }) {
  const { can } = useApp();
  const s = useQuery({ queryKey: ['summary', range], queryFn: () => api('reports.summary', range) });
  const t = useQuery({ queryKey: ['trend', range], queryFn: () => api<any[]>('reports.trend', range) });
  if (s.isLoading) return <Loading />;
  const d = s.data;
  return (
    <div className="col gap-lg">
      <div className="grid grid-4">
        <Stat tone="primary" label="صافي المبيعات" value={<span className="num">{money(d.netSales)}</span>} hint={`${num(d.invoices)} فاتورة`} />
        {can('reports.cost') && <Stat label="مجمل الربح (المبيعات − التكلفة)" value={<span className="num">{money(d.grossProfit)}</span>} hint={d.grossMarginPct !== null ? `هامش ${d.grossMarginPct}%` : ''} />}
        <Stat label="المصروفات" value={<span className="num">{money(d.expenses)}</span>} />
        {can('reports.cost') && <Stat label="صافي الربح" value={<span className={`num ${d.netProfit < 0 ? 'danger-text' : 'success-text'}`}>{money(d.netProfit)}</span>} hint="بعد التكلفة والمصروفات" />}
      </div>
      <div className="grid grid-4">
        <Stat label="متوسط قيمة الفاتورة" value={<span className="num">{money(d.avgBasket)}</span>} />
        <Stat label="متوسط الأصناف في الفاتورة" value={num(d.avgLines, 1)} />
        <Stat label="الخصومات" value={<span className="num">{money(d.discounts)}</span>} />
        <Stat label="المرتجعات" value={<span className="num">{money(d.returns.total)}</span>} hint={`${d.returns.count} مرتجع • ${d.voids.count} ملغاة`} />
      </div>
      <div className="card">
        <div className="card-head"><h3>المبيعات {can('reports.cost') ? 'والربح ' : ''}يوميًا</h3></div>
        <div className="card-body">{t.data?.length ? <BarChart data={t.data.slice(-62)} valueKey="sales" secondKey={can('reports.cost') ? 'grossProfit' : undefined} label={(x) => x.date.slice(8, 10)} /> : <Empty title="لا توجد بيانات" />}</div>
      </div>
      <div className="card">
        <div className="card-head"><h3>قائمة الدخل المختصرة</h3><div className="grow" /><button className="btn sm" onClick={() => void api('print.doc', { title: `تقرير ${dateOnly(range.from)} - ${dateOnly(range.to)}`, rows: summaryRows(d, can('reports.cost')) })}><Printer size={14} /> طباعة</button></div>
        <table className="table"><tbody>{summaryRows(d, can('reports.cost')).map(([k, v]) => <tr key={k}><td>{k}</td><td className="n bold">{v}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}

function ProductsTab({ range }: { range: Range }) {
  const { can } = useApp();
  const [sort, setSort] = useState<'qty' | 'count' | 'revenue' | 'profit' | 'margin'>('qty');
  const r = useQuery({ queryKey: ['prodPerf', range, sort], queryFn: () => api<any[]>('reports.products', { ...range, sort, limit: 200 }) });
  return (
    <div className="card">
      <div className="row wrap" style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
        <span className="muted small">ترتيب حسب:</span>
        <Segmented value={sort} onChange={setSort} options={[
          { value: 'qty', label: 'الأكثر مبيعًا (كمية)' }, { value: 'count', label: 'الأكثر ظهورًا في الفواتير' }, { value: 'revenue', label: 'الأعلى إيرادًا' },
          ...(can('reports.cost') ? [{ value: 'profit' as const, label: 'الأكثر ربحًا' }, { value: 'margin' as const, label: 'أعلى هامش' }] : []),
        ]} />
      </div>
      {r.isLoading ? <Loading /> : !r.data?.length ? <Empty title="لا توجد مبيعات في هذه الفترة" /> : (
        <div className="table-wrap" style={{ maxHeight: 620 }}><table className="table">
          <thead><tr><th>#</th><th>المنتج</th><th>التصنيف</th><th className="n">الكمية المباعة</th><th className="n">عدد الفواتير</th><th className="n">الإيراد</th>{can('reports.cost') && <><th className="n">التكلفة</th><th className="n">الربح</th><th className="n">الهامش</th></>}<th className="n">المخزون</th></tr></thead>
          <tbody>{r.data.map((p, i) => (
            <tr key={p.id}><td className="muted">{i + 1}</td><td className="bold"><Link to={`/products/${p.id}`}>{p.name}{p.variant_name ? ` ${p.variant_name}` : ''}</Link></td><td className="small">{p.category_name ?? '—'}</td>
              <td className="n">{qty(p.qty)} {p.unit_symbol}</td><td className="n">{p.times}</td><td className="n">{money(p.revenue)}</td>
              {can('reports.cost') && <><td className="n muted">{money(p.cost)}</td><td className={`n bold ${p.profit < 0 ? 'danger-text' : ''}`}>{money(p.profit)}</td><td className="n">{pct(p.margin)}</td></>}
              <td className="n">{qty(p.stock)}</td></tr>
          ))}</tbody></table></div>
      )}
    </div>
  );
}

function CategoriesTab({ range }: { range: Range }) {
  const { can } = useApp();
  const r = useQuery({ queryKey: ['catPerf', range], queryFn: () => api<any[]>('reports.categories', range) });
  const total = (r.data ?? []).reduce((a, c) => a + c.revenue, 0);
  return (
    <div className="card">
      {!r.data?.length ? <Empty title="لا توجد مبيعات" /> : (
        <table className="table"><thead><tr><th>التصنيف</th><th className="n">الإيراد</th><th className="n">النسبة</th>{can('reports.cost') && <><th className="n">الربح</th><th className="n">الهامش</th></>}<th className="n">الفواتير</th></tr></thead>
          <tbody>{r.data.map((c) => <tr key={c.name}><td className="bold">{c.name}</td><td className="n">{money(c.revenue)}</td><td className="n">{pct(total ? (c.revenue / total) * 100 : 0)}</td>{can('reports.cost') && <><td className="n bold">{money(c.profit)}</td><td className="n">{pct(c.revenue ? (c.profit / c.revenue) * 100 : null)}</td></>}<td className="n">{c.invoices}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

function CashiersTab({ range }: { range: Range }) {
  const r = useQuery({ queryKey: ['cashiers', range], queryFn: () => api<any[]>('reports.cashiers', range) });
  return (
    <div className="card">
      {!r.data?.length ? <Empty title="لا توجد بيانات" /> : (
        <table className="table"><thead><tr><th>الكاشير</th><th className="n">الفواتير</th><th className="n">صافي المبيعات</th><th className="n">متوسط الفاتورة</th><th className="n">الخصومات</th><th className="n">المرتجعات</th><th className="n">الملغاة</th><th className="n">الورديات</th><th className="n">عجز الخزنة</th><th className="n">زيادة الخزنة</th></tr></thead>
          <tbody>{r.data.map((c) => <tr key={c.userId}><td className="bold">{c.name}</td><td className="n">{c.invoices}</td><td className="n bold">{money(c.netSales)}</td><td className="n">{money(c.avgBasket)}</td><td className="n">{money(c.discounts)}</td><td className="n">{c.returns.count} — {money(c.returns.total)}</td><td className="n">{c.voids.count}</td><td className="n">{c.shifts}</td><td className="n danger-text">{c.shortage ? money(c.shortage) : '—'}</td><td className="n warning-text">{c.overage ? money(c.overage) : '—'}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

function ValuationTab() {
  const { can } = useApp();
  const v = useQuery({ queryKey: ['valuation'], queryFn: () => api('reports.valuation') });
  if (!v.data) return <Loading />;
  return (
    <div className="col gap-lg">
      <div className="grid grid-3">
        {can('reports.cost') && <Stat tone="primary" label="قيمة المخزون بالتكلفة" value={<span className="num">{money(v.data.cost_value)}</span>} />}
        <Stat label="قيمة المخزون بسعر البيع" value={<span className="num">{money(v.data.retail_value)}</span>} />
        {can('reports.cost') && <Stat label="الربح المتوقع من المخزون الحالي" value={<span className="num">{money(v.data.retail_value - v.data.cost_value)}</span>} />}
      </div>
      <div className="card"><table className="table"><thead><tr><th>التصنيف</th><th className="n">المنتجات</th>{can('reports.cost') && <th className="n">بالتكلفة</th>}<th className="n">بسعر البيع</th></tr></thead>
        <tbody>{v.data.byCategory.map((c: any) => <tr key={c.name}><td>{c.name}</td><td className="n">{c.products}</td>{can('reports.cost') && <td className="n">{money(c.cost_value)}</td>}<td className="n">{money(c.retail_value)}</td></tr>)}</tbody></table></div>
    </div>
  );
}

function DeadTab() {
  const { settings, can } = useApp();
  const [days, setDays] = useState(String(settings['inventory.deadStockDays'] ?? 30));
  const r = useQuery({ queryKey: ['dead', days], queryFn: () => api<any[]>('reports.deadStock', { days: Number(days) }) });
  const value = (r.data ?? []).reduce((a, p) => a + (p.avg_cost ? Math.round((p.stock * p.avg_cost) / 1000) : 0), 0);
  return (
    <div className="col gap-lg">
      <div className="row"><span>لم تُبع منذ</span><Segmented value={days} onChange={setDays} options={[{ value: '7', label: '7 أيام' }, { value: '14', label: '14 يوم' }, { value: '30', label: '30 يوم' }, { value: '60', label: '60 يوم' }, { value: '90', label: '90 يوم' }]} /></div>
      {can('reports.cost') && <div className="alert warning">لديك <b>{money(value)}</b> من رأس المال في {r.data?.length ?? 0} منتج لم يتحرك منذ {days} يوم.</div>}
      <div className="card">
        {!r.data?.length ? <Empty title="لا توجد بضاعة راكدة 👍" /> : (
          <table className="table"><thead><tr><th>المنتج</th><th className="n">المخزون</th>{can('reports.cost') && <th className="n">القيمة</th>}<th>آخر بيع</th></tr></thead>
            <tbody>{r.data.map((p) => <tr key={p.id}><td className="bold"><Link to={`/products/${p.id}`}>{p.name}{p.variant_name ? ` ${p.variant_name}` : ''}</Link></td><td className="n">{qty(p.stock)} {p.unit_symbol}</td>{can('reports.cost') && <td className="n">{money(Math.round((p.stock * p.avg_cost) / 1000))}</td>}<td className="small">{daysAgo(p.last_sale)}</td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  );
}

function PurchasesTab({ range }: { range: Range }) {
  const r = useQuery({ queryKey: ['purchRep', range], queryFn: () => api('reports.purchases', range) });
  if (!r.data) return <Loading />;
  return (
    <div className="col gap-lg">
      <div className="grid grid-3">
        <Stat label="إجمالي المشتريات" value={<span className="num">{money(r.data.total.total)}</span>} hint={`${r.data.total.count} فاتورة`} />
        <Stat label="المدفوع" value={<span className="num">{money(r.data.total.paid)}</span>} hint={`المتبقي ${money(r.data.total.total - r.data.total.paid)}`} />
        <Stat label="مرتجعات الشراء" value={<span className="num">{money(r.data.returns.total)}</span>} />
      </div>
      <div className="card"><table className="table"><thead><tr><th>المورد</th><th className="n">الفواتير</th><th className="n">الإجمالي</th><th className="n">المدفوع</th><th className="n">الرصيد الحالي المستحق</th></tr></thead>
        <tbody>{r.data.bySupplier.map((s: any) => <tr key={s.name}><td className="bold">{s.id ? <Link to={`/suppliers/${s.id}`}>{s.name}</Link> : s.name}</td><td className="n">{s.count}</td><td className="n">{money(s.total)}</td><td className="n">{money(s.paid)}</td><td className="n bold">{s.balance !== null ? money(s.balance) : '—'}</td></tr>)}</tbody></table></div>
    </div>
  );
}

function DebtsTab() {
  const r = useQuery({ queryKey: ['debts'], queryFn: () => api('reports.debts') });
  if (!r.data) return <Loading />;
  return (
    <div className="col gap-lg">
      <div className="grid grid-2">
        <Stat tone="primary" label="لك عند العملاء" value={<span className="num">{money(r.data.customersOwe)}</span>} />
        <Stat label="عليك للموردين" value={<span className="num">{money(r.data.storeOwes)}</span>} />
      </div>
      <div className="grid grid-2">
        <div className="card"><div className="card-head"><h3>العملاء</h3></div>{!r.data.customers.length ? <Empty title="لا توجد مديونيات" /> : <table className="table"><thead><tr><th>العميل</th><th className="n">الرصيد</th><th>آخر دفعة</th></tr></thead><tbody>{r.data.customers.map((c: any) => <tr key={c.id}><td><Link to={`/customers/${c.id}`}>{c.name}</Link><div className="xs muted num">{c.phone}</div></td><td className={`n bold ${c.balance > 0 ? 'danger-text' : 'success-text'}`}>{money(c.balance)}</td><td className="small">{dateOnly(c.last_payment)}</td></tr>)}</tbody></table>}</div>
        <div className="card"><div className="card-head"><h3>الموردون</h3></div>{!r.data.suppliers.length ? <Empty title="لا توجد مستحقات" /> : <table className="table"><thead><tr><th>المورد</th><th className="n">المستحق</th><th>آخر سداد</th></tr></thead><tbody>{r.data.suppliers.map((s: any) => <tr key={s.id}><td><Link to={`/suppliers/${s.id}`}>{s.name}</Link></td><td className="n bold">{money(s.balance)}</td><td className="small">{dateOnly(s.last_payment)}</td></tr>)}</tbody></table>}</div>
      </div>
    </div>
  );
}
