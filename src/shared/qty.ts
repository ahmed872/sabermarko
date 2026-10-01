/**
 * Quantities are stored as INTEGER thousandths ("milli") of a unit.
 * 1 piece  = 1000
 * 0.25 kg  = 250
 * Unit conversion factors are also stored in milli of the base unit:
 * carton of 30 bags -> factor 30000, gram (base kg) -> factor 1.
 */
export const Q = 1000;

export function toMilli(q: number): number {
  if (!Number.isFinite(q)) return 0;
  return Math.round(Math.round(q * Q * 1000) / 1000);
}

export function fromMilli(m: number): number {
  return m / Q;
}

/** Convert a quantity expressed in a unit (milli) to base-unit milli. */
export function toBaseQty(qtyMilli: number, factorMilli: number): number {
  return Math.round((qtyMilli * factorMilli) / Q);
}

/** Convert base-unit milli to a quantity in a given unit (milli). */
export function fromBaseQty(baseMilli: number, factorMilli: number): number {
  if (factorMilli === 0) return 0;
  return Math.round((baseMilli * Q) / factorMilli);
}

/** Line amount = unit price (minor) x quantity (milli). */
export function lineAmount(unitPriceMinor: number, qtyMilli: number): number {
  const v = (unitPriceMinor * qtyMilli) / Q;
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

export function formatQty(milli: number, digits: 'latn' | 'arab' = 'latn'): string {
  const v = fromMilli(milli);
  return new Intl.NumberFormat(digits === 'arab' ? 'ar-EG' : 'en-US', { maximumFractionDigits: 3 }).format(v);
}
