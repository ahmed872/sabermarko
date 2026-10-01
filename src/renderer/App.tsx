import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { AppProvider, useApp } from './lib/app';
import { ConfirmProvider, Loading, ToastProvider } from './components/ui';
import { ApprovalProvider } from './components/Approval';
import { Layout } from './components/Layout';
import { LicenseBlocked, LoginScreen, RecoveryScreen, SetupWizard } from './pages/Auth';
import type { Permission } from '../shared/permissions';

const POS = lazy(() => import('./pages/POS'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Products = lazy(() => import('./pages/Products'));
const ProductForm = lazy(() => import('./pages/ProductForm'));
/** a fresh form per product: never carry one product's fields into another (or into "new product") */
function ProductFormKeyed() { const { id } = useParams(); return <ProductForm key={`edit-${id}`} />; }
const ProductDetail = lazy(() => import('./pages/ProductDetail'));
const Catalog = lazy(() => import('./pages/Catalog'));
const Inventory = lazy(() => import('./pages/Inventory'));
const Stocktake = lazy(() => import('./pages/Stocktake'));
const Purchases = lazy(() => import('./pages/Purchases'));
const PurchaseForm = lazy(() => import('./pages/PurchaseForm'));
const PurchaseOrders = lazy(() => import('./pages/PurchaseOrders'));
const Parties = lazy(() => import('./pages/Parties'));
const Sales = lazy(() => import('./pages/Sales'));
const Shifts = lazy(() => import('./pages/Shifts'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Reports = lazy(() => import('./pages/Reports'));
const DayClose = lazy(() => import('./pages/DayClose'));
const Users = lazy(() => import('./pages/Users'));
const Settings = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));
const Insights = lazy(() => import('./pages/Insights'));

function Guard({ perm, children }: { perm?: Permission; children: React.ReactNode }) {
  const { can } = useApp();
  if (perm && !can(perm)) return <div className="alert warning">ليس لديك صلاحية لعرض هذه الصفحة.</div>;
  return <>{children}</>;
}

function GlobalKeys() {
  const nav = useNavigate();
  const { can } = useApp();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F1' && !location.hash.startsWith('#/pos') && can('pos.sell')) { e.preventDefault(); nav('/pos'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [nav, can]);
  return null;
}

function Home() {
  const { can } = useApp();
  // cashiers land directly on the sales screen
  if (!can('reports.view') && can('pos.sell')) return <Navigate to="/pos" replace />;
  return <Dashboard />;
}

function Root() {
  const { boot, user } = useApp();
  if (!boot) return <div className="auth-bg"><span className="spinner" /></div>;
  if (boot.recovery) return <RecoveryScreen />;
  if (boot.needsSetup) return <SetupWizard />;
  if (!user) return <LoginScreen />;
  if (!boot.license.canOperate) return <LicenseBlocked />;
  return (
    <HashRouter>
      <GlobalKeys />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="pos" element={<Guard perm="pos.sell"><POS /></Guard>} />
            <Route path="insights" element={<Guard perm="reports.view"><Insights /></Guard>} />
            <Route path="products" element={<Guard perm="products.view"><Products /></Guard>} />
            <Route path="products/new" element={<Guard perm="products.manage"><ProductForm key="new" /></Guard>} />
            <Route path="products/:id" element={<Guard perm="products.view"><ProductDetail /></Guard>} />
            <Route path="products/:id/edit" element={<Guard perm="products.manage"><ProductFormKeyed /></Guard>} />
            <Route path="catalog" element={<Guard perm="products.manage"><Catalog /></Guard>} />
            <Route path="inventory/*" element={<Guard perm="inventory.view"><Inventory /></Guard>} />
            <Route path="stocktake/*" element={<Guard perm="inventory.stocktake"><Stocktake /></Guard>} />
            <Route path="purchases" element={<Guard perm="purchases.view"><Purchases /></Guard>} />
            <Route path="purchases/new" element={<Guard perm="purchases.manage"><PurchaseForm /></Guard>} />
            <Route path="purchase-orders/*" element={<Guard perm="purchases.view"><PurchaseOrders /></Guard>} />
            <Route path="suppliers/*" element={<Guard perm="purchases.view"><Parties kind="supplier" /></Guard>} />
            <Route path="customers/*" element={<Guard perm="customers.manage"><Parties kind="customer" /></Guard>} />
            <Route path="sales/*" element={<Guard perm="sales.view"><Sales /></Guard>} />
            <Route path="returns" element={<Guard perm="sales.view"><Sales tab="returns" /></Guard>} />
            <Route path="quotations" element={<Guard perm="quotations.manage"><Sales tab="quotations" /></Guard>} />
            <Route path="shifts" element={<Guard perm="pos.sell"><Shifts /></Guard>} />
            <Route path="expenses" element={<Guard perm="expenses.manage"><Expenses /></Guard>} />
            <Route path="reports" element={<Guard perm="reports.view"><Reports /></Guard>} />
            <Route path="day-close" element={<Guard perm="day.close"><DayClose /></Guard>} />
            <Route path="users" element={<Guard perm="users.manage"><Users /></Guard>} />
            <Route path="settings" element={<Guard perm="settings.manage"><Settings /></Guard>} />
            <Route path="audit" element={<Guard perm="audit.view"><Admin tab="audit" /></Guard>} />
            <Route path="backup" element={<Guard perm="backup.manage"><Admin tab="backup" /></Guard>} />
            <Route path="license" element={<Guard perm="license.manage"><Admin tab="license" /></Guard>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </HashRouter>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider>
          <ApprovalProvider>
            <Root />
          </ApprovalProvider>
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
