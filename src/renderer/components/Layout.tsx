import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3, Boxes, ClipboardList, Coins, FileText, Home, KeyRound, LogOut, Package, Receipt, RotateCcw, Settings, ShoppingCart,
  Sparkles, Truck, UserCog, Users, Wallet, DatabaseBackup, ScrollText, CalendarCheck, PackageSearch, Timer,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useApp } from '../lib/app';
import { api } from '../lib/api';
import { money } from '../lib/format';
import type { Permission } from '../../shared/permissions';
import { StoreLogo } from '../pages/Auth';

interface NavItem { to: string; label: string; icon: ReactNode; perm?: Permission; feature?: Parameters<ReturnType<typeof useApp>['feature']>[0]; badge?: number }

export function Layout() {
  const { user, settings, can, feature, logout, boot } = useApp();
  const loc = useLocation();
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api<any[]>('reports.alerts'), refetchInterval: 120_000, enabled: !!user });
  const shift = useQuery({ queryKey: ['shift'], queryFn: () => api('shifts.current'), enabled: can('pos.sell'), refetchInterval: 60_000 });
  const lowCount = alerts.data?.find((a) => a.key === 'low')?.count;
  const expCount = (alerts.data?.find((a) => a.key === 'expiring')?.count ?? 0) + (alerts.data?.find((a) => a.key === 'expired')?.count ?? 0);
  const groups: { title: string; items: NavItem[] }[] = [
    { title: '', items: [{ to: '/', label: 'الرئيسية', icon: <Home size={18} /> }, { to: '/insights', label: 'اقتراحات البيع', icon: <Sparkles size={18} />, perm: 'reports.view' }] },
    { title: 'المبيعات', items: [
      { to: '/sales', label: 'الفواتير', icon: <Receipt size={18} />, perm: 'sales.view' },
      { to: '/returns', label: 'المرتجعات', icon: <RotateCcw size={18} />, perm: 'sales.view' },
      { to: '/quotations', label: 'عروض الأسعار', icon: <FileText size={18} />, perm: 'quotations.manage', feature: 'quotations' },
      { to: '/shifts', label: 'الورديات والخزنة', icon: <Timer size={18} />, perm: 'pos.sell' },
    ] },
    { title: 'المنتجات والمخزون', items: [
      { to: '/products', label: 'المنتجات', icon: <Package size={18} />, perm: 'products.view' },
      { to: '/inventory', label: 'المخزون', icon: <Boxes size={18} />, perm: 'inventory.view', badge: lowCount },
      { to: '/stocktake', label: 'الجرد', icon: <ClipboardList size={18} />, perm: 'inventory.stocktake' },
      { to: '/inventory/expiry', label: 'الصلاحية', icon: <CalendarCheck size={18} />, perm: 'inventory.view', feature: 'expiry', badge: expCount || undefined },
    ] },
    { title: 'المشتريات', items: [
      { to: '/purchases', label: 'المشتريات', icon: <ShoppingCart size={18} />, perm: 'purchases.view' },
      { to: '/purchase-orders', label: 'طلبات الشراء', icon: <PackageSearch size={18} />, perm: 'purchases.view', feature: 'purchaseOrders' },
      { to: '/suppliers', label: 'الموردون', icon: <Truck size={18} />, perm: 'purchases.view' },
    ] },
    { title: 'الحسابات', items: [
      { to: '/customers', label: 'العملاء والمديونيات', icon: <Users size={18} />, perm: 'customers.manage' },
      { to: '/expenses', label: 'المصروفات', icon: <Wallet size={18} />, perm: 'expenses.manage' },
      { to: '/day-close', label: 'إغلاق اليوم', icon: <Coins size={18} />, perm: 'day.close' },
      { to: '/reports', label: 'التقارير', icon: <BarChart3 size={18} />, perm: 'reports.view' },
    ] },
    { title: 'الإدارة', items: [
      { to: '/users', label: 'المستخدمون والصلاحيات', icon: <UserCog size={18} />, perm: 'users.manage' },
      { to: '/audit', label: 'سجل العمليات', icon: <ScrollText size={18} />, perm: 'audit.view' },
      { to: '/backup', label: 'النسخ الاحتياطي', icon: <DatabaseBackup size={18} />, perm: 'backup.manage' },
      { to: '/settings', label: 'الإعدادات', icon: <Settings size={18} />, perm: 'settings.manage' },
      { to: '/license', label: 'الترخيص', icon: <KeyRound size={18} />, perm: 'license.manage' },
    ] },
  ];
  const visible = (i: NavItem) => (!i.perm || can(i.perm)) && (!i.feature || feature(i.feature));
  const lic = boot?.license;
  const isPos = loc.pathname.startsWith('/pos');
  return (
    <div className="shell">
      <aside className="sidebar no-print">
        <div className="brand">
          <StoreLogo name={settings['store.name']} logo={settings['store.logo']} className="logo" />
          <div><div className="name">{settings['store.name']}</div><div className="sub">{user?.fullName} — {user?.roleName}</div></div>
        </div>
        <nav className="nav">
          {can('pos.sell') && <NavLink to="/pos" className="nav-sell"><ShoppingCart size={20} /> بيع جديد <span className="kbd">F1</span></NavLink>}
          {groups.map((g) => {
            const items = g.items.filter(visible);
            if (!items.length) return null;
            return (
              <div className="nav-group" key={g.title || 'main'}>
                {g.title && <div className="nav-title">{g.title}</div>}
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/' || i.to === '/inventory'} className={({ isActive }) => `item ${isActive ? 'active' : ''}`}>
                    {i.icon}<span>{i.label}</span>{i.badge ? <span className="badge">{i.badge}</span> : null}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="foot row">
          <div className="grow">
            {shift.data ? <span>وردية مفتوحة — {money(shift.data.expected)}</span> : can('pos.sell') ? <span>لا توجد وردية مفتوحة</span> : null}
          </div>
          <button className="btn ghost sm icon" title="تسجيل الخروج" style={{ color: 'inherit' }} onClick={() => void logout()}><LogOut size={16} /></button>
        </div>
      </aside>
      <div className="main">
        {lic && lic.state === 'trial' && !isPos && (
          <div className="license-banner trial no-print"><KeyRound size={15} /> نسخة تجريبية — متبقٍ {lic.daysLeft} يوم. {can('license.manage') && <NavLink to="/license">تفعيل البرنامج</NavLink>}</div>
        )}
        {lic && lic.state === 'licensed' && lic.type === 'temporary' && (lic.daysLeft ?? 99) <= 14 && (
          <div className="license-banner warn no-print"><KeyRound size={15} /> الترخيص ينتهي خلال {lic.daysLeft} يوم. {can('license.manage') && <NavLink to="/license">تجديد</NavLink>}</div>
        )}
        <div className={isPos ? 'grow' : 'content'} style={isPos ? { minHeight: 0 } : undefined}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
