import { useMemo } from 'react';
import { describeFilter, isWideOpen, seedFilter, type RangeFilter } from '../../analysis/filters';
import { formatValue, pluralize } from '../../domain/format';
import type { Dataset, FieldId } from '../../domain/types';
import { buildCategories } from '../../domain/variables';
import { FieldSelect, NO_FIELD } from '../Bits';
import { DistStrip } from '../DistStrip';
import { Icon } from '../Icon';
import { RangeSlider } from '../RangeSlider';

interface Props {
  ds: Dataset;
  /** Every experiment, before filtering — the denominator. */
  total: number;
  /** After filtering — what the charts are drawing. */
  visible: readonly number[];
  query: string;
  onQuery: (q: string) => void;
  filters: readonly RangeFilter[];
  onFilters: (f: RangeFilter[]) => void;
  focus: FieldId;
  onFocus: (f: FieldId) => void;
  band: readonly [number, number] | null;
  onBand: (b: [number, number] | null) => void;
  /** Runs inside the band, for the count beside the slider. */
  inBand: number;
}

/**
 * The two decisions every chart below depends on, made once.
 *
 * WHICH EXPERIMENTS — an id search and any number of intervals on any column.
 * These are hard filters: a chart never draws a row this bar has excluded, so
 * the count printed here is true of everything underneath it.
 *
 * WHICH PROPERTY, AND WHICH SLICE OF IT — the property under investigation and
 * an interval on it. This is a highlight rather than a filter: the runs outside
 * the slice stay on screen, faded, because "what is different about the runs in
 * this range" is only answerable while the other runs are still visible.
 *
 * Putting both here is what stops the page being ten charts with ten sets of
 * controls, each quietly showing a different subset of the study.
 */
export function ScopeBar({
  ds,
  total,
  visible,
  query,
  onQuery,
  filters,
  onFilters,
  focus,
  onFocus,
  band,
  onBand,
  inBand,
}: Props) {
  const focusMeta = ds.fields.get(focus);
  const filterable = useMemo(() => [...ds.outputs, ...ds.formulation, ...ds.process], [ds]);
  const groups = useMemo(() => {
    const m = new Map<FieldId, string>();
    for (const c of buildCategories(ds)) for (const f of c.fields) m.set(f, c.label);
    for (const o of ds.outputs) m.set(o, 'Measured properties');
    return m;
  }, [ds]);

  const addFilter = (id: FieldId) => {
    const seeded = seedFilter(ds, id);
    if (!seeded) return;
    onFilters([...filters.filter((f) => f.field !== id), seeded]);
  };
  const patchFilter = (id: FieldId, range: [number, number]) =>
    onFilters(filters.map((f) => (f.field === id ? { ...f, range } : f)));
  const dropFilter = (id: FieldId) => onFilters(filters.filter((f) => f.field !== id));

  const narrowed = visible.length !== total;
  const bandDomain = focusMeta?.domain ?? [0, 1];
  /**
   * The interval the controls actually drive.
   *
   * `band` arrives readonly because nothing downstream may write through it,
   * but RangeSlider and DistStrip both take a mutable pair, so it is copied
   * once here rather than cast away at each call site.
   */
  const active: [number, number] = band ? [band[0], band[1]] : [bandDomain[0], bandDomain[1]];

  return (
    <section className="scope" aria-label="What the charts below are showing">
      <div className="scope__row">
        <label className="search scope__search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={query}
            placeholder="Find an experiment by id"
            aria-label="Find an experiment by id"
            onChange={(e) => onQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              className="search__clear"
              onClick={() => onQuery('')}
              aria-label="Clear the search"
            >
              <Icon name="close" size={10} />
            </button>
          )}
        </label>

        <span className="scope__div" aria-hidden="true" />

        <FieldSelect
          id="dw-focus"
          label="asking about"
          value={focus}
          options={ds.outputs}
          ds={ds}
          onChange={onFocus}
        />

        <span className="scope__div" aria-hidden="true" />

        <FieldSelect
          id="dw-addfilter"
          label="filter"
          value={NO_FIELD}
          options={[NO_FIELD, ...filterable]}
          ds={ds}
          groups={groups}
          noneLabel="add a variable…"
          onChange={(f) => f !== NO_FIELD && addFilter(f)}
        />

        <span className="scope__spacer" />

        <span className={`scope__count ${visible.length === 0 ? 'is-none' : ''}`}>
          <strong className="num">{visible.length}</strong>
          <span>
            of {total} {pluralize(total, 'experiment')}
          </span>
        </span>
        {(narrowed || query) && (
          <button
            type="button"
            className="btn btn--ghost btn--xs"
            onClick={() => {
              onFilters([]);
              onQuery('');
            }}
          >
            <Icon name="reset" size={11} />
            Clear filters
          </button>
        )}
      </div>

      {filters.length > 0 && (
        <ul className="scope__filters">
          {filters.map((f) => {
            const meta = ds.fields.get(f.field);
            if (!meta) return null;
            return (
              <li key={f.field} className={`flt ${isWideOpen(ds, f) ? 'is-open' : ''}`}>
                <div className="flt__head">
                  <span className="flt__name">{describeFilter(ds, f)}</span>
                  <button
                    type="button"
                    className="flt__drop"
                    onClick={() => dropFilter(f.field)}
                    aria-label={`Remove the ${meta.short} filter`}
                  >
                    <Icon name="close" size={9} />
                  </button>
                </div>
                <RangeSlider
                  label={meta.label}
                  min={meta.domain[0]}
                  max={meta.domain[1]}
                  step={stepFor(meta.decimals)}
                  value={f.range}
                  format={(v) => formatValue(v, meta.decimals)}
                  onChange={(r) => patchFilter(f.field, r)}
                />
              </li>
            );
          })}
        </ul>
      )}

      {focusMeta && (
        <div className="scope__band">
          <div className="scope__bandLabel">
            <span className="scope__bandTitle">{focusMeta.label} range</span>
            <span className="scope__bandHint">
              {band ? (
                <>
                  <strong className="num">{inBand}</strong> of {visible.length} in range
                </>
              ) : (
                'drag to isolate a slice, and every chart re-reads against it'
              )}
            </span>
            {band && (
              <button type="button" className="linkbtn" onClick={() => onBand(null)}>
                whole range
              </button>
            )}
          </div>
          <div className="scope__bandPick">
            <RangeSlider
              label={focusMeta.label}
              min={focusMeta.domain[0]}
              max={focusMeta.domain[1]}
              step={stepFor(focusMeta.decimals)}
              value={active}
              format={(v) => formatValue(v, focusMeta.decimals)}
              onChange={(b) => onBand(b)}
            />
            <DistStrip ds={ds} field={focus} rows={visible} region={active} height={28} />
          </div>
        </div>
      )}
    </section>
  );
}

const stepFor = (decimals: number) => (decimals <= 0 ? 1 : decimals === 1 ? 0.1 : 0.01);
