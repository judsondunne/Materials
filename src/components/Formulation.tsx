import { useMemo, useState } from 'react';
import { buildCategories, categoryColor, type Category } from '../domain/variables';
import { formatValue } from '../domain/format';
import type { Dataset } from '../domain/types';

export interface Amounts {
  [field: string]: number;
}

export function amountsOf(ds: Dataset, row: number): Amounts {
  const out: Amounts = {};
  for (const f of [...ds.formulation, ...ds.process]) {
    const v = ds.columns.get(f)?.[row];
    out[f] = v !== undefined && Number.isFinite(v) ? v : 0;
  }
  return out;
}

/**
 * The formulation as one bar: which shelves it is built from, in proportion.
 *
 * A nineteen-row table tells you the numbers; this tells you the compound. Two of
 * them stacked is usually enough to see what kind of formulation you are looking
 * at before reading a single figure.
 */
export function CompositionBar({
  ds,
  amounts,
  height = 10,
  showLabels = false,
}: {
  ds: Dataset;
  amounts: Amounts;
  height?: number;
  showLabels?: boolean;
}) {
  const cats = useMemo(() => buildCategories(ds), [ds]);
  const segments = useMemo(() => {
    const formulationCats = cats.filter((c) => c.id !== 'process');
    const parts = formulationCats.map((c) => ({
      cat: c,
      amount: c.fields.reduce((s, f) => s + Math.max(0, amounts[f] ?? 0), 0),
    }));
    const total = parts.reduce((s, p) => s + p.amount, 0);
    return { parts: parts.filter((p) => p.amount > 0), total };
  }, [cats, amounts]);

  if (segments.total <= 0) {
    return <div className="comp comp--empty" style={{ height }} aria-hidden="true" />;
  }

  return (
    <div className="comp__wrap">
      <div className="comp" style={{ height }} role="img" aria-label={compLabel(segments.parts, segments.total)}>
        {segments.parts.map(({ cat, amount }) => (
          <span
            key={cat.id}
            className="comp__seg"
            style={{
              width: `${(amount / segments.total) * 100}%`,
              background: `var(${categoryColor(cat.id)})`,
            }}
            title={`${cat.label} ${amount.toFixed(1)}`}
          />
        ))}
      </div>
      {showLabels && (
        <div className="comp__key">
          {segments.parts.map(({ cat, amount }) => (
            <span key={cat.id} className="comp__keyItem">
              <span className="comp__dot" style={{ background: `var(${categoryColor(cat.id)})` }} />
              {cat.label}
              <span className="num comp__keyVal">{amount.toFixed(1)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const compLabel = (parts: { cat: Category; amount: number }[], total: number) =>
  parts.map((p) => `${p.cat.label} ${Math.round((p.amount / total) * 100)}%`).join(', ');

/**
 * The full recipe, shelf by shelf.
 *
 * Ingredients set to zero are real information — a formulation that omits carbon
 * black is making a choice — but eighteen zeros would swamp the four amounts that
 * matter, so they collapse behind a count and can be opened.
 */
export function FormulationView({
  ds,
  amounts,
  compare,
  defaultShowUnused = false,
}: {
  ds: Dataset;
  amounts: Amounts;
  /** A second formulation to draw as a faint reference behind each bar. */
  compare?: Amounts | null;
  defaultShowUnused?: boolean;
}) {
  const [showUnused, setShowUnused] = useState(defaultShowUnused);
  const cats = useMemo(() => buildCategories(ds), [ds]);

  const unusedCount = useMemo(
    () => ds.formulation.filter((f) => (amounts[f] ?? 0) <= 0).length,
    [ds.formulation, amounts],
  );

  return (
    <div className="form">
      {cats.map((cat) => {
        const fields = cat.fields.filter((f) => showUnused || cat.id === 'process' || (amounts[f] ?? 0) > 0);
        if (fields.length === 0) return null;
        const scale = maxOf(ds, cat);
        return (
          <section key={cat.id} className="form__cat">
            <h4 className="form__catHead">
              <span className="form__catDot" style={{ background: `var(${categoryColor(cat.id)})` }} />
              {cat.label}
              <span className="form__catRole">{cat.role}</span>
            </h4>
            <ul className="form__list">
              {fields.map((f) => {
                const meta = ds.fields.get(f)!;
                const v = amounts[f] ?? 0;
                const ref = compare?.[f];
                const lo = cat.id === 'process' ? meta.domain[0] : 0;
                const norm = (x: number) => (scale > lo ? Math.max(0, (x - lo) / (scale - lo)) : 0);
                return (
                  <li key={f} className={`form__row ${v <= 0 && cat.id !== 'process' ? 'is-off' : ''}`}>
                    <span className="form__name">{meta.short}</span>
                    <span className="form__track">
                      {ref !== undefined && Number.isFinite(ref) && (
                        <span className="form__ref" style={{ width: `${norm(ref) * 100}%` }} />
                      )}
                      <span
                        className="form__fill"
                        style={{
                          width: `${norm(v) * 100}%`,
                          background: `var(${categoryColor(cat.id)})`,
                        }}
                      />
                    </span>
                    <span className="form__val num">
                      {v <= 0 && cat.id !== 'process' ? '—' : formatValue(v, meta.decimals)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {unusedCount > 0 && (
        <button type="button" className="form__toggle" onClick={() => setShowUnused((v) => !v)}>
          {showUnused
            ? `Hide ${unusedCount} unused ingredients`
            : `Show ${unusedCount} unused ingredients`}
        </button>
      )}
    </div>
  );
}

/** Bars are scaled to the largest amount ever recorded on that shelf, so the same
 *  ingredient is the same length on every screen. */
function maxOf(ds: Dataset, cat: Category): number {
  let max = 0;
  for (const f of cat.fields) {
    const hi = ds.fields.get(f)?.domain[1] ?? 0;
    if (hi > max) max = hi;
  }
  return max;
}
