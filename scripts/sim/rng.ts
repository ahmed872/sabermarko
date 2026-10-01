/** Deterministic random helpers (mulberry32) so every simulation run is reproducible from its seed. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    float: (lo: number, hi: number) => lo + next() * (hi - lo),
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    /** geometric-ish count >= 1 */
    count: (pStop: number, max: number) => { let n = 1; while (n < max && next() > pStop) n++; return n; },
    poisson: (lambda: number) => {
      if (lambda > 50) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss()));
      const L = Math.exp(-lambda); let k = 0; let p = 1;
      do { k++; p *= next(); } while (p > L);
      return k - 1;
    },
    shuffle: <T>(arr: T[]): T[] => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },
  };
  function gauss() { const u = 1 - next(); const v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  return r;
}
export type Rng = ReturnType<typeof makeRng>;

/** Weighted sampler rebuilt whenever weights change (daily). */
export class WeightedPicker {
  private cum: Float64Array;
  private total = 0;
  constructor(private ids: number[], weights: number[]) {
    this.cum = new Float64Array(ids.length);
    let acc = 0;
    for (let i = 0; i < ids.length; i++) { acc += Math.max(0, weights[i]); this.cum[i] = acc; }
    this.total = acc;
  }
  pick(rnd: () => number): number | null {
    if (this.total <= 0) return null;
    const x = rnd() * this.total;
    let lo = 0; let hi = this.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] < x) lo = mid + 1; else hi = mid; }
    return this.ids[lo];
  }
}
