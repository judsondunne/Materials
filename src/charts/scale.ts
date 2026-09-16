export interface LinearScale {
  (v: number): number;
  invert: (px: number) => number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const fn = ((v: number) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0))) as LinearScale;
  fn.invert = (px: number) => (span === 0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * span);
  fn.domain = domain;
  fn.range = range;
  return fn;
}

/** Human-friendly tick values (1/2/5 × 10^n) inside the domain. */
export function ticks(domain: [number, number], count = 5): number[] {
  const [lo, hi] = domain;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Math.round(v / step) * step);
  }
  return out;
}

/** Expand a domain to round numbers so axes do not end on arbitrary values. */
export function niceDomain(domain: [number, number], count = 5): [number, number] {
  const [lo, hi] = domain;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi === lo) return [lo - 0.5, hi + 0.5];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

export function padDomain(domain: [number, number], pct = 0.06): [number, number] {
  const [lo, hi] = domain;
  if (hi === lo) return [lo - 1, hi + 1];
  const pad = (hi - lo) * pct;
  return [lo - pad, hi + pad];
}
