import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Info, Package, PackagePlus, Receipt, RotateCcw, ShoppingCart, Sparkles, TrendingUp, Wallet, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { money, num, qty } from '../lib/format';
import { Empty, Loading } from '../components/ui';
import { BarChart, BarList } from '../components/Charts';
import { MonthlyFocus } from './Insights';

function Delta({ now, before }: { now: number; before: number | null | undefined }) {
  if (before === null || before === undefined || before === 0) return null;
  const d = ((now - before) / Math.abs(before)) * 100;
  const up = d >= 0;
  return <span className={`small ${up ? 'success-text' : 'danger-text'}`}>{up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />} {Math.abs(d).toFixed(0)}% عن أمس</span>;
}

export default function Dashboard() {
  const { can, settings, user } = useApp();
  const d = useQuery({ queryKey: ['dashboard'], queryFn: () => api('reports.dashboard'), refetchInterval: 60_000 });
  const products = useQuery({ queryKey: ['products', 'count'], queryFn: () => api('products.list', { pageSize: 1 }) });
  if (d.isLoading) return <Loading rows={6} />;
  const t = d.data.today;
  const y = d.data.yesterday;
  const isNew = products.data && products.data.total === 0;
  const icons = { danger: <XCircle size={16} />, warning: <AlertTriangle size={16} />, info: <Info size={16} /> };
  return (
    <div className="col gap-lg">
      <div className="row">
        <div><h1>{new Date().getHours() < 12 ? 'صباح الخير' : 'مساء الخير'}، {user?.fullName}</h1><div className="muted small">{settings['store.name']} — ملخص اليوم {d.data.scope === 'mine' ? '(مبيعاتك أنت)' : ''}</div></div>
        <div className="grow" />
        {can('pos.sell') && <Link className="btn primary lg" to="/pos"><ShoppingCart size={18} /> بيع جديد</Link>}
        {can('products.manage') && <Link className="btn lg" to="/products/new"><PackagePlus size={18} /> منتج جديد</Link>}
        {can('purchases.manage') && <Link className="btn lg" to="/purchases/new"><Package size={18} /> شراء بضاعة</Link>}
      </div>

      {isNew && (
        <div className="card pad">
          <div className="row top gap-lg">
            <div className="auth-logo" style={{ margin: 0, width: 56, height: 56 }}><Sparkles /></div>
            <div className="grow">
              <h2>ابدأ في 3 خطوات</h2>
              <ol className="small" style={{ lineHeight: 2, margin: '6px 0 0', paddingInlineStart: 18 }}>
                <li><Link to="/products/new">أضف منتجاتك</Link> — يكفي الاسم والسعر، أو <Link to="/products">استوردها من Excel</Link>.</li>
                <li>سجّل الكميات الموجودة (عند إضافة المنتج) أو من <Link to="/purchases/new">فاتورة شراء</Link>.</li>
                <li>افتح <Link to="/pos">شاشة البيع</Link> وابدأ البيع.</li>
              </ol>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-4">
        <div className="card stat primary">
          <div className="label"><Receipt size={15} /> مبيعات اليوم</div>
          <div className="value num">{money(t.netSales)}</div>
          <div className="hint">{num(t.invoices)} فاتورة — متوسط الفاتورة {money(t.avgBasket)}</div>
        </div>
        {t.grossProfit !== null ? (
          <div className="card stat">
            <div className="label"><TrendingUp size={15} /> ربح اليوم (بعد التكلفة)</div>
            <div className={`value num ${t.grossProfit < 0 ? 'danger-text' : ''}`}>{money(t.grossProfit)}</div>
            <div className="hint">{t.grossMarginPct !== null ? `هامش ${t.grossMarginPct}%` : ''} {t.expenses > 0 ? ` — صافي بعد المصروفات ${money(t.netProfit)}` : ''}</div>
          </div>
        ) : <div className="card stat"><div className="label">عدد الأصناف المباعة</div><div className="value num">{num(t.avgItems * t.invoices, 1)}</div></div>}
        <div className="card stat">
          <div className="label"><Wallet size={15} /> النقدية المحصلة</div>
          <div className="value num">{money(t.payments.cash - t.refunds.cash)}</div>
          <div className="hint">كارت {money(t.payments.card)} • محفظة {money(t.payments.wallet)} • آجل {money(t.payments.credit)}</div>
        </div>
        <div className="card stat">
          <div className="label"><RotateCcw size={15} /> المرتجعات والخصومات</div>
          <div className="value num">{money(t.returns.total)}</div>
          <div className="hint">{t.returns.count} مرتجع • خصومات {money(t.discounts)}{t.voids.count ? ` • ${t.voids.count} فاتورة ملغاة` : ''}</div>
        </div>
      </div>
      {y && t.invoices > 0 && <div className="row small muted" style={{ marginTop: -8 }}><Delta now={t.netSales} before={y.netSales} /></div>}

      <MonthlyFocus compact />

      <div className="grid" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
        <div className="card">
          <div className="card-head"><h3>المبيعات — آخر 14 يوم</h3><div className="grow" /><span className="xs muted"><span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--primary-600)', borderRadius: 2 }} /> المبيعات {can('reports.cost') && <><span style={{ display: 'inline-block', width: 10, height: 10, background: '#f59e0b', borderRadius: 2, marginInlineStart: 8 }} /> الربح</>}</span></div>
          <div className="card-body">
            {d.data.trend.length ? <BarChart data={d.data.trend} valueKey="sales" secondKey={can('reports.cost') ? 'grossProfit' : undefined} label={(x) => x.date.slice(8, 10) + '/' + x.date.slice(5, 7)} /> : <Empty title="لا توجد بيانات" />}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><AlertTriangle size={17} color="var(--warning)" /><h3>يحتاج انتباهك</h3></div>
          <div className="card-body attention">
            {!d.data.alerts.length ? <div className="muted small">كل شيء على ما يرام ✓</div> : d.data.alerts.map((a: any) => (
              <Link key={a.key} to={a.link}><span className={`dot ${a.level}`}>{icons[a.level as keyof typeof icons]}</span><span className="grow">{a.text}</span></Link>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><TrendingUp size={17} /><h3>الأسرع حركة — آخر 7 أيام</h3><div className="grow" />{can('reports.view') && <Link to="/reports?tab=products" className="btn sm">التفاصيل</Link>}</div>
          <div className="card-body">
            {!d.data.top.length ? <Empty title="لا توجد مبيعات بعد" /> : <BarList rows={d.data.top.map((p: any) => ({ label: `${p.name}${p.variant_name ? ' ' + p.variant_name : ''}`, value: p.qty, display: `${qty(p.qty)} ${p.unit_symbol}`, sub: `${p.times} فاتورة` }))} />}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><TrendingUp size={17} /><h3>الأكثر ربحًا — آخر 7 أيام</h3></div>
          <div className="card-body">
            {!can('reports.cost') ? <div className="muted small">يحتاج صلاحية رؤية الأرباح.</div> : !d.data.top.length ? <Empty title="لا توجد مبيعات بعد" /> : (
              <BarList rows={[...d.data.top].sort((a: any, b: any) => b.profit - a.profit).map((p: any) => ({ label: `${p.name}${p.variant_name ? ' ' + p.variant_name : ''}`, value: p.profit, display: money(p.profit), sub: p.margin !== null ? `هامش ${p.margin}%` : undefined }))} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
