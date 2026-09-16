export interface Summary {
  n: number;
  nPresent: number;
  min: number;
  max: number;
  mean: number;
  sd: number;
  q1: number;
  median: number;
  q3: number;
}

const EMPTY: Summary = {
  n: 0,
  nPresent: 0,
  min: NaN,
  max: NaN,
  mean: NaN,
  sd: NaN,
  q1: NaN,
  median: NaN,
  q3: NaN,
};

export function describe(col: Float64Array, rows: readonly number[]): Summary {
  const vals: number[] = [];
  let present = 0;
  for (const r of rows) {
    const v = col[r];
    if (v === undefined || !Number.isFinite(v)) continue;
    vals.push(v);
    if (v > 0) present++;
  }
  const n = vals.length;
  if (n === 0) return EMPTY;
  vals.sort((a, b) => a - b);
  let sum = 0;
  for (const v of vals) sum += v;
  const mean = sum / n;
  let ss = 0;
  for (const v of vals) ss += (v - mean) ** 2;
  return {
    n,
    nPresent: present,
    min: vals[0]!,
    max: vals[n - 1]!,
    mean,
    sd: Math.sqrt(ss / n),
    q1: quantileSorted(vals, 0.25),
    median: quantileSorted(vals, 0.5),
    q3: quantileSorted(vals, 0.75),
  };
}

export function quantileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0]!;
  const i = (n - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export interface Correlation {
  /** null when undefined — never 0, which would read as "no relationship". */
  r: number | null;
  n: number;
}

/** Pearson correlation over rows where both series are finite. */
export function pearson(
  x: Float64Array,
  y: Float64Array,
  rows: readonly number[],
): Correlation {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of rows) {
    const a = x[r];
    const b = y[r];
    if (a === undefined || b === undefined) continue;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    xs.push(a);
    ys.push(b);
  }
  const n = xs.length;
  if (n < 3) return { r: null, n };
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) (mx += xs[i]!), (my += ys[i]!);
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return { r: null, n };
  return { r: num / Math.sqrt(dx * dy), n };
}

/** Average ranks for ties — important here, where zeros are common. */
export function rank(values: readonly number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = avg;
    i = j + 1;
  }
  return out;
}

export function spearman(
  x: Float64Array,
  y: Float64Array,
  rows: readonly number[],
): Correlation {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of rows) {
    const a = x[r];
    const b = y[r];
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    xs.push(a);
    ys.push(b);
  }
  if (xs.length < 3) return { r: null, n: xs.length };
  const rx = Float64Array.from(rank(xs));
  const ry = Float64Array.from(rank(ys));
  const all = rx.map((_, i) => i);
  return pearson(rx, ry, Array.from(all));
}

/**
 * Correlation ratio: the share of a property's variation explained by group
 * membership. Reduces to |r| for a linear continuous relationship, which lets a
 * categorical choice and an ingredient amount be ranked in one list.
 */
export function eta(y: Float64Array, groups: readonly string[], rows: readonly number[]): number {
  const buckets = new Map<string, number[]>();
  const all: number[] = [];
  for (const r of rows) {
    const v = y[r];
    const g = groups[r];
    if (v === undefined || g === undefined || !Number.isFinite(v)) continue;
    all.push(v);
    const b = buckets.get(g);
    if (b) b.push(v);
    else buckets.set(g, [v]);
  }
  if (all.length < 3 || buckets.size < 2) return 0;
  const grand = all.reduce((s, v) => s + v, 0) / all.length;
  let sst = 0;
  for (const v of all) sst += (v - grand) ** 2;
  if (sst === 0) return 0;
  let ssb = 0;
  for (const b of buckets.values()) {
    const m = b.reduce((s, v) => s + v, 0) / b.length;
    ssb += b.length * (m - grand) ** 2;
  }
  return Math.sqrt(Math.min(1, ssb / sst));
}

/** Two-tailed critical |r| at alpha for n observations (Student t inversion). */
export function criticalR(n: number, alpha = 0.05): number {
  if (n < 4) return 1;
  const df = n - 2;
  const t = inverseT(1 - alpha / 2, df);
  return t / Math.sqrt(t * t + df);
}

/** Hill's approximation of the inverse Student-t CDF — adequate for a UI threshold. */
function inverseT(p: number, df: number): number {
  const z = inverseNormal(p);
  const g1 = (z ** 3 + z) / 4;
  const g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96;
  const g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3;
}

function inverseNormal(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) return -inverseNormal(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export interface Fit {
  slope: number;
  intercept: number;
  r: number;
  r2: number;
  n: number;
}

export function olsFit(x: Float64Array, y: Float64Array, rows: readonly number[]): Fit | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of rows) {
    const a = x[r];
    const b = y[r];
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    xs.push(a);
    ys.push(b);
  }
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) (mx += xs[i]!), (my += ys[i]!);
  mx /= n;
  my /= n;
  let num = 0;
  let den = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    den += a * a;
    dy += b * b;
  }
  if (den === 0 || dy === 0) return null;
  const slope = num / den;
  const r = num / Math.sqrt(den * dy);
  return { slope, intercept: my - slope * mx, r, r2: r * r, n };
}

export interface Bin {
  x0: number;
  x1: number;
  count: number;
}

/** Freedman–Diaconis width with a Sturges fallback, over a caller-supplied domain
 *  so that two subsets can be overlaid on identical bins. */
export function histogram(
  col: Float64Array,
  rows: readonly number[],
  domain: [number, number],
  binCount?: number,
): Bin[] {
  const [lo, hi] = domain;
  const vals: number[] = [];
  for (const r of rows) {
    const v = col[r];
    if (v !== undefined && Number.isFinite(v)) vals.push(v);
  }
  let k = binCount ?? 0;
  if (!k) {
    if (vals.length < 2) k = 1;
    else {
      const sorted = [...vals].sort((a, b) => a - b);
      const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
      const fd = iqr > 0 ? (2 * iqr) / Math.cbrt(vals.length) : 0;
      k = fd > 0 ? Math.ceil((hi - lo) / fd) : Math.ceil(Math.log2(vals.length) + 1);
      k = Math.max(5, Math.min(24, k));
    }
  }
  if (hi <= lo) return [{ x0: lo, x1: lo, count: vals.length }];
  const width = (hi - lo) / k;
  const bins: Bin[] = Array.from({ length: k }, (_, i) => ({
    x0: lo + i * width,
    x1: lo + (i + 1) * width,
    count: 0,
  }));
  for (const v of vals) {
    const i = Math.min(k - 1, Math.max(0, Math.floor((v - lo) / width)));
    bins[i]!.count++;
  }
  return bins;
}

/** Standardised mean difference against the full-population spread. */
export function standardisedDiff(subsetMean: number, allMean: number, allSd: number): number {
  if (!Number.isFinite(allSd) || allSd === 0) return 0;
  return (subsetMean - allMean) / allSd;
}

export function paretoFront(
  points: { row: number; a: number; b: number }[],
  dirA: 'max' | 'min',
  dirB: 'max' | 'min',
): Set<number> {
  const better = (v: number, w: number, d: 'max' | 'min') => (d === 'max' ? v >= w : v <= w);
  const strictly = (v: number, w: number, d: 'max' | 'min') => (d === 'max' ? v > w : v < w);
  const front = new Set<number>();
  for (const p of points) {
    const dominated = points.some(
      (q) =>
        q.row !== p.row &&
        better(q.a, p.a, dirA) &&
        better(q.b, p.b, dirB) &&
        (strictly(q.a, p.a, dirA) || strictly(q.b, p.b, dirB)),
    );
    if (!dominated) front.add(p.row);
  }
  return front;
}

export interface Neighbor {
  row: number;
  distance: number;
  diffs: { field: string; delta: number; from: number; to: number }[];
}

/** Nearest formulations by Euclidean distance over composition fields. */
export function nearestNeighbors(
  row: number,
  rows: readonly number[],
  fields: readonly string[],
  columns: Map<string, Float64Array>,
  k = 3,
): Neighbor[] {
  const out: Neighbor[] = [];
  for (const other of rows) {
    if (other === row) continue;
    let sum = 0;
    const diffs: Neighbor['diffs'] = [];
    for (const f of fields) {
      const col = columns.get(f);
      if (!col) continue;
      const a = col[row] ?? 0;
      const b = col[other] ?? 0;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const d = b - a;
      sum += d * d;
      if (Math.abs(d) > 0.05) diffs.push({ field: f, delta: d, from: a, to: b });
    }
    diffs.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    out.push({ row: other, distance: Math.sqrt(sum), diffs: diffs.slice(0, 3) });
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, k);
}
