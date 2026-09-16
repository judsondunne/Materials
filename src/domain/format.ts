/** Number of decimals actually used by the source values, capped for sanity. */
export function inferDecimals(values: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    const s = String(v);
    const dot = s.indexOf('.');
    if (dot >= 0) {
      const d = s.length - dot - 1;
      if (d > max) max = d;
    }
    if (max >= 3) return 3;
  }
  return max;
}

export function formatValue(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatCompact(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(decimals);
}

export function formatSigned(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(decimals);
}

export function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(d: Date | null): string {
  if (!d) return '—';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function formatDateShort(d: Date | null): string {
  if (!d) return '—';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
