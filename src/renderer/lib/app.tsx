import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, registerAuthLost, registerLicenseLost } from './api';
import { setCurrency } from './format';
import { hasPermission, type Permission } from '../../shared/permissions';
import type { StoreSettings } from '../../shared/settings';
import type { LicenseStatus } from '../../main/license/core';

export interface SessionUser { id: number; username: string; fullName: string; roleCode: string; roleName: string; permissions: Permission[] | '*'; maxDiscountPct: number | null }
export interface Boot {
  recovery: boolean; needsSetup?: boolean; license: LicenseStatus; user?: SessionUser | null; settings?: Partial<StoreSettings>; version: string;
  vendor?: { productName: string; productNameAr: string; companyName: string; supportPhone: string; website: string }; backups?: any[];
}

interface AppCtx {
  boot: Boot | null;
  user: SessionUser | null;
  settings: StoreSettings;
  can: (p: Permission) => boolean;
  feature: (k: 'multiLocation' | 'expiry' | 'purchaseOrders' | 'priceLists' | 'promotions' | 'quotations' | 'creditSales' | 'tax') => boolean;
  refresh: () => Promise<void>;
  setSession: (user: SessionUser | null, settings?: StoreSettings) => void;
  setSettings: (s: StoreSettings) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AppCtx>(null as never);
export const useApp = () => useContext(Ctx);

export function applyDisplay(s: Partial<StoreSettings>) {
  setCurrency({ code: s['currency.code'] ?? 'EGP', symbol: s['currency.symbol'] ?? 'ج.م', digits: s['ui.digits'] ?? 'latn' });
  document.documentElement.style.setProperty('--scale', String(s['ui.fontScale'] ?? 1));
  if (s['store.name']) document.title = s['store.name'];
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Boot | null>(null);
  const qc = useQueryClient();
  const refresh = useCallback(async () => {
    const b = await api<Boot>('app.boot');
    if (b.settings) applyDisplay(b.settings);
    setBoot(b);
  }, []);
  useEffect(() => {
    void refresh();
    registerAuthLost(() => setBoot((b) => (b ? { ...b, user: null } : b)));
    registerLicenseLost(() => void refresh());
  }, [refresh]);
  const user = boot?.user ?? null;
  const settings = (boot?.settings ?? {}) as StoreSettings;
  const value: AppCtx = {
    boot, user, settings,
    can: (p) => !!user && hasPermission(user.permissions, p),
    feature: (k) => !!settings[`features.${k}` as keyof StoreSettings],
    refresh,
    setSession: (u, s) => { if (s) applyDisplay(s); setBoot((b) => (b ? { ...b, user: u, settings: s ?? b.settings } : b)); qc.clear(); },
    setSettings: (s) => { applyDisplay(s); setBoot((b) => (b ? { ...b, settings: s } : b)); },
    logout: async () => { await api('auth.logout'); qc.clear(); await refresh(); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
