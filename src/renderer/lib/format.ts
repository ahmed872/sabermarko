import { formatMoney, toMinor, type CurrencyConfig } from '../../shared/money';
import { formatQty, toMilli } from '../../shared/qty';
import { parseDecimal } from '../../shared/arabic';

let currency: CurrencyConfig = { code: 'EGP', symbol: 'ج.م', digits: 'latn' };
export function setCurrency(c: CurrencyConfig) { currency = c; }
export function getCurrency() { return currency; }

export const money = (minor: number | null | undefined, withSymbol = true) => (minor === null || minor === undefined ? '—' : formatMoney(minor, currency, { withSymbol }));
export const qty = (milli: number | null | undefined) => (milli === null || milli === undefined ? '—' : formatQty(milli, currency.digits));
export const num = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? '—' : new Intl.NumberFormat(currency.digits === 'arab' ? 'ar-EG' : 'en-US', { maximumFractionDigits: digits }).format(n);
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${num(n, 1)}%`);

/** user text -> minor units (null when invalid) */
export function parseMoney(s: string): number | null {
  const v = parseDecimal(s);
  return v === null ? null : toMinor(v);
}
/** user text -> milli (null when invalid) */
export function parseQty(s: string): number | null {
  const v = parseDecimal(s);
  return v === null ? null : toMilli(v);
}
export const minorToInput = (m: number | null | undefined) => (m === null || m === undefined ? '' : String(m / 100));
export const milliToInput = (m: number | null | undefined) => (m === null || m === undefined ? '' : String(m / 1000));

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayIso = () => isoDate(new Date());
export function addDaysIso(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + days));
}

export function dateTime(s: string | null | undefined) {
  if (!s) return '—';
  const [d, t] = s.split('T');
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}${t ? ' ' + t.slice(0, 5) : ''}`;
}
export function dateOnly(s: string | null | undefined) {
  if (!s) return '—';
  const [y, m, day] = s.slice(0, 10).split('-');
  return `${day}/${m}/${y}`;
}
export function daysAgo(s: string | null | undefined) {
  if (!s) return 'لم يُبع';
  const diff = Math.floor((Date.now() - new Date(s.slice(0, 10) + 'T00:00:00').getTime()) / 86_400_000);
  if (diff <= 0) return 'اليوم';
  if (diff === 1) return 'أمس';
  if (diff === 2) return 'منذ يومين';
  if (diff <= 10) return `منذ ${diff} أيام`;
  return `منذ ${diff} يومًا`;
}

export const METHOD_LABEL: Record<string, string> = { cash: 'نقدي', card: 'كارت', wallet: 'محفظة', credit: 'آجل', bank: 'تحويل' };
