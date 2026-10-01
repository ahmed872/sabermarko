/**
 * Money is stored and computed as INTEGER minor units (e.g. piasters).
 * Never use floating point for stored money values.
 */
export const MINOR = 100;

export function toMinor(major: number): number {
  if (!Number.isFinite(major)) return 0;
  // Guard against binary float artefacts (e.g. 1.005 * 100 = 100.49999)
  return Math.round(Math.round(major * MINOR * 1000) / 1000);
}

export function fromMinor(minor: number): number {
  return minor / MINOR;
}

/** Round half away from zero to an integer. */
export function roundInt(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** Apply a percentage (0..100, may be fractional) to an amount in minor units. */
export function percentOf(amount: number, pct: number): number {
  return roundInt((amount * pct) / 100);
}

export interface CurrencyConfig {
  code: string;
  symbol: string;
  digits: 'latn' | 'arab';
}

export function formatMoney(minor: number, cur: CurrencyConfig, opts: { withSymbol?: boolean } = {}): string {
  const value = fromMinor(minor);
  const nf = new Intl.NumberFormat(cur.digits === 'arab' ? 'ar-EG' : 'en-US', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  const s = nf.format(value);
  return opts.withSymbol === false ? s : `${s} ${cur.symbol}`;
}
