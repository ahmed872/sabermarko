import { ZodError } from 'zod';
import { AppError, type AppErrorPayload } from '../shared/errors';
import type { Ctx, SessionUser } from './services/context';
import { log } from './logger';
import * as products from './services/products';
import * as inventory from './services/inventory';
import * as pricing from './services/pricing';
import * as sales from './services/sales';
import * as shifts from './services/shifts';
import * as parties from './services/parties';
import * as purchases from './services/purchases';
import * as expenses from './services/expenses';
import * as users from './services/users';
import * as settings from './services/settings';
import * as reports from './services/reports';
import * as analytics from './services/analytics';
import * as reco from './services/recommendations';

type Handler = (ctx: Ctx, p: any) => unknown | Promise<unknown>;
export interface Route { fn: Handler; public?: boolean; licenseExempt?: boolean }

/**
 * The complete renderer-facing API. Each route is authorized inside the
 * service (requirePerm) — the renderer is never trusted. Routes marked
 * `public` work before login; `licenseExempt` routes keep working after the
 * trial/license ends (so a shop can always log in, activate and back up).
 */
export const routes: Record<string, Route> = {
  // auth & setup
  'auth.loginUsers': { fn: (c) => users.listLoginUsers(c), public: true, licenseExempt: true },
  'auth.changePassword': { fn: (c, p) => users.changeOwnPassword(c, p.current, p.next), licenseExempt: true },
  'setup.status': { fn: (c) => settings.setupStatus(c), public: true, licenseExempt: true },
  'setup.complete': { fn: (c, p) => settings.completeSetup(c, p), public: true, licenseExempt: true },
  'settings.public': { fn: (c) => settings.publicSettings(c), public: true, licenseExempt: true },
  'settings.get': { fn: (c) => settings.getSettings(c), licenseExempt: true },
  'settings.update': { fn: (c, p) => settings.updateSettings(c, p) },
  'audit.list': { fn: (c, p) => settings.listAudit(c, p) },

  // users & roles
  'users.list': { fn: (c) => users.listUsers(c) },
  'users.names': { fn: (c) => users.listUserNames(c) },
  'users.quota': { fn: (c) => { if (!c.user) throw new AppError('NOT_AUTHENTICATED'); return users.userQuota(c); } },
  'users.save': { fn: (c, p) => users.saveUser(c, p.id ?? null, p.data) },
  'roles.list': { fn: (c) => users.listRoles(c) },
  'roles.save': { fn: (c, p) => users.saveRole(c, p.id ?? null, p.data) },
  'roles.delete': { fn: (c, p) => users.deleteRole(c, p.id) },

  // catalog
  'products.list': { fn: (c, p) => products.listProducts(c, p ?? {}) },
  'products.get': { fn: (c, p) => products.getProduct(c, p.id) },
  'products.create': { fn: (c, p) => products.createProduct(c, p) },
  'products.update': { fn: (c, p) => products.updateProduct(c, p.id, p.data) },
  'products.setActive': { fn: (c, p) => products.setProductActive(c, p.id, !!p.active) },
  'products.delete': { fn: (c, p) => products.deleteProduct(c, p.id) },
  'products.favorite': { fn: (c, p) => products.toggleFavorite(c, p.id, !!p.favorite) },
  'products.priceHistory': { fn: (c, p) => products.priceHistory(c, p.id) },
  'products.supplierPrices': { fn: (c, p) => products.supplierPrices(c, p.id) },
  'products.import': { fn: (c, p) => products.importProducts(c, p.rows) },
  'pos.search': { fn: (c, p) => products.posSearch(c, p.q ?? '', p) },
  'pos.product': { fn: (c, p) => products.posProduct(c, p.id) },
  'categories.list': { fn: (c, p) => products.listCategories(c, p ?? {}) },
  'categories.save': { fn: (c, p) => products.saveCategory(c, p) },
  'categories.delete': { fn: (c, p) => products.deleteCategory(c, p.id) },
  'brands.list': { fn: (c) => products.listBrands(c) },
  'brands.save': { fn: (c, p) => products.saveBrand(c, p) },
  'brands.delete': { fn: (c, p) => products.deleteBrand(c, p.id) },
  'units.list': { fn: (c) => products.listUnits(c) },
  'units.save': { fn: (c, p) => products.saveUnit(c, p) },
  'groups.list': { fn: (c) => products.listGroups(c) },
  'priceLists.list': { fn: (c) => products.listPriceLists(c) },
  'priceLists.save': { fn: (c, p) => products.savePriceList(c, p) },
  'locations.list': { fn: (c) => inventory.listLocations(c) },
  'locations.save': { fn: (c, p) => inventory.saveLocation(c, p) },
  'promotions.list': { fn: (c) => pricing.listPromotions(c) },
  'promotions.save': { fn: (c, p) => pricing.savePromotion(c, p.id ?? null, p.data) },
  'promotions.delete': { fn: (c, p) => pricing.deletePromotion(c, p.id) },

  // inventory
  'inventory.ledger': { fn: (c, p) => inventory.productLedger(c, p.productId, p) },
  'inventory.movements': { fn: (c, p) => inventory.movementsReport(c, p) },
  'inventory.batches': { fn: (c, p) => inventory.listBatches(c, p.productId) },
  'inventory.docs': { fn: (c, p) => inventory.listInventoryDocs(c, p ?? {}) },
  'inventory.adjust': { fn: (c, p) => inventory.createAdjustment(c, p) },
  'inventory.transfer': { fn: (c, p) => inventory.createTransfer(c, p) },
  'stocktake.list': { fn: (c) => inventory.listStocktakes(c) },
  'stocktake.start': { fn: (c, p) => inventory.startStocktake(c, p ?? {}) },
  'stocktake.get': { fn: (c, p) => inventory.getStocktake(c, p.id, p) },
  'stocktake.count': { fn: (c, p) => inventory.setStocktakeCount(c, p.id, p.productId, p.qty) },
  'stocktake.complete': { fn: (c, p) => inventory.completeStocktake(c, p.id) },
  'stocktake.cancel': { fn: (c, p) => inventory.cancelStocktake(c, p.id) },

  // sales
  'sales.quote': { fn: (c, p) => sales.quoteCart(c, p) },
  'sales.checkout': { fn: (c, p) => sales.checkout(c, p) },
  'sales.get': { fn: (c, p) => sales.getSale(c, p.id) },
  'sales.find': { fn: (c, p) => sales.findSaleByNo(c, p.invoiceNo) },
  'sales.list': { fn: (c, p) => sales.listSales(c, p) },
  'sales.void': { fn: (c, p) => sales.voidSale(c, p) },
  'returns.create': { fn: (c, p) => sales.createReturn(c, p) },
  'returns.get': { fn: (c, p) => sales.getReturn(c, p.id) },
  'returns.list': { fn: (c, p) => sales.listReturns(c, p) },
  'held.create': { fn: (c, p) => sales.holdSale(c, p) },
  'held.list': { fn: (c) => sales.listHeld(c) },
  'held.get': { fn: (c, p) => sales.getHeld(c, p.id) },
  'held.delete': { fn: (c, p) => sales.deleteHeld(c, p.id) },
  'quotations.create': { fn: (c, p) => sales.createQuotation(c, p) },
  'quotations.get': { fn: (c, p) => sales.getQuotation(c, p.id) },
  'quotations.list': { fn: (c) => sales.listQuotations(c) },
  'quotations.cancel': { fn: (c, p) => sales.cancelQuotation(c, p.id) },

  // shifts & cash
  'shifts.current': { fn: (c) => { const s = shifts.currentShift(c); return s ? shifts.getShiftSummary(c, s.id) : null; } },
  'shifts.open': { fn: (c, p) => shifts.openShift(c, p) },
  'shifts.cash': { fn: (c, p) => shifts.cashInOut(c, p) },
  'shifts.close': { fn: (c, p) => shifts.closeShift(c, p) },
  'shifts.summary': { fn: (c, p) => shifts.getShiftSummary(c, p.id) },
  'shifts.list': { fn: (c, p) => shifts.listShifts(c, p ?? {}) },
  'shifts.movements': { fn: (c, p) => shifts.shiftMovements(c, p.id) },

  // customers & suppliers
  'customers.list': { fn: (c, p) => parties.listParties(c, 'customer', p ?? {}) },
  'customers.get': { fn: (c, p) => parties.getParty(c, 'customer', p.id) },
  'customers.save': { fn: (c, p) => parties.saveParty(c, 'customer', p.id ?? null, p.data) },
  'customers.delete': { fn: (c, p) => parties.deleteParty(c, 'customer', p.id) },
  'customers.pay': { fn: (c, p) => parties.recordPayment(c, 'customer', p) },
  'customers.adjust': { fn: (c, p) => parties.adjustBalance(c, 'customer', p) },
  'suppliers.list': { fn: (c, p) => parties.listParties(c, 'supplier', p ?? {}) },
  'suppliers.get': { fn: (c, p) => parties.getParty(c, 'supplier', p.id) },
  'suppliers.save': { fn: (c, p) => parties.saveParty(c, 'supplier', p.id ?? null, p.data) },
  'suppliers.delete': { fn: (c, p) => parties.deleteParty(c, 'supplier', p.id) },
  'suppliers.pay': { fn: (c, p) => parties.recordPayment(c, 'supplier', p) },
  'suppliers.adjust': { fn: (c, p) => parties.adjustBalance(c, 'supplier', p) },

  // purchases
  'purchases.create': { fn: (c, p) => purchases.createPurchase(c, p) },
  'purchases.get': { fn: (c, p) => purchases.getPurchase(c, p.id) },
  'purchases.list': { fn: (c, p) => purchases.listPurchases(c, p) },
  'purchases.return': { fn: (c, p) => purchases.createPurchaseReturn(c, p) },
  'purchases.returns': { fn: (c, p) => purchases.listPurchaseReturns(c, p) },
  'po.save': { fn: (c, p) => purchases.savePurchaseOrder(c, p.id ?? null, p.data) },
  'po.get': { fn: (c, p) => purchases.getPurchaseOrder(c, p.id) },
  'po.list': { fn: (c, p) => purchases.listPurchaseOrders(c, p ?? {}) },
  'po.cancel': { fn: (c, p) => purchases.cancelPurchaseOrder(c, p.id) },
  'po.receiveDraft': { fn: (c, p) => purchases.poReceiveDraft(c, p.id) },

  // expenses
  'expenses.categories': { fn: (c) => expenses.listExpenseCategories(c) },
  'expenses.saveCategory': { fn: (c, p) => expenses.saveExpenseCategory(c, p) },
  'expenses.create': { fn: (c, p) => expenses.createExpense(c, p) },
  'expenses.delete': { fn: (c, p) => expenses.deleteExpense(c, p.id, p.reason ?? '') },
  'expenses.list': { fn: (c, p) => expenses.listExpenses(c, p) },

  // reports
  'reports.dashboard': { fn: (c) => reports.dashboard(c) },
  'reports.alerts': { fn: (c) => reports.alerts(c) },
  'reports.summary': { fn: (c, p) => reports.summaryReport(c, p.from, p.to, p.userId) },
  'reports.trend': { fn: (c, p) => reports.dailyTrend(c, p.from, p.to) },
  'reports.products': { fn: (c, p) => reports.productPerformance(c, p.from, p.to, p) },
  'reports.categories': { fn: (c, p) => reports.categoryPerformance(c, p.from, p.to) },
  'reports.cashiers': { fn: (c, p) => reports.cashierPerformance(c, p.from, p.to) },
  'reports.lowStock': { fn: (c) => reports.lowStock(c) },
  'reports.reorder': { fn: (c, p) => reports.reorderSuggestions(c, p ?? {}) },
  'reports.deadStock': { fn: (c, p) => reports.deadStock(c, p?.days) },
  'reports.expiring': { fn: (c, p) => reports.expiringBatches(c, p?.days) },
  'inventory.expiry': { fn: (c) => reports.expiryOverview(c) },
  'reports.valuation': { fn: (c) => reports.inventoryValuation(c) },
  'reports.debts': { fn: (c) => reports.debtsReport(c) },
  'reports.purchases': { fn: (c, p) => reports.purchasesReport(c, p.from, p.to) },
  // smart retail intelligence
  'intel.overview': { fn: (c) => analytics.intelOverview(c) },
  'intel.products': { fn: (c, p) => analytics.classifiedProducts(c, p ?? {}) },
  'intel.demand': { fn: (c) => analytics.demandLeaders(c) },
  'intel.basket': { fn: (c) => analytics.basketPairs(c, p0(c)) },
  'intel.seasonal': { fn: (c) => analytics.seasonalSignals(c) },
  'intel.focus': { fn: (c) => reco.monthlyFocus(c) },
  'intel.suggestions': { fn: (c, p) => reco.listSuggestions(c, p ?? {}) },
  'intel.generate': { fn: (c) => reco.generateSuggestions(c) },
  'intel.simulate': { fn: (c, p) => reco.simulateProposal(c, p) },
  'intel.approve': { fn: (c, p) => reco.approveSuggestion(c, p) },
  'intel.reject': { fn: (c, p) => reco.rejectSuggestion(c, p) },
  'intel.mutes': { fn: (c) => reco.listMutes(c) },
  'intel.unmute': { fn: (c, p) => reco.removeMute(c, p.id) },
  'intel.results': { fn: (c) => reco.promotionResults(c) },
  'day.preview': { fn: (c, p) => reports.dayClosingPreview(c, p?.date) },
  'day.list': { fn: (c) => reports.listDayClosings(c) },
};

const p0 = (_c: Ctx) => ({});

export function toErrorPayload(e: unknown, channel: string): AppErrorPayload {
  if (e instanceof AppError) return { code: e.code, params: e.params };
  if (e instanceof ZodError) {
    const issue = e.issues[0];
    log.warn(`validation failed on ${channel}`, e.issues);
    return { code: 'VALIDATION', params: { detail: issue ? issue.path.join('.') : '' } };
  }
  const msg = String((e as Error)?.message ?? e);
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return { code: 'DB_BUSY' };
  if (code.startsWith('SQLITE_CONSTRAINT_FOREIGNKEY') || msg.includes('FOREIGN KEY')) {
    log.warn(`FK constraint on ${channel}`, msg);
    return { code: 'IN_USE' };
  }
  if (code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || msg.includes('UNIQUE constraint')) {
    log.warn(`unique constraint on ${channel}`, msg);
    return { code: 'DUPLICATE_NAME', params: { name: '' } };
  }
  log.error(`unhandled error on ${channel}`, e);
  return { code: 'UNKNOWN' };
}

export type { SessionUser };
