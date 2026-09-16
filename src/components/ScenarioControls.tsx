import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { formulationTotal, rebalance, type ScenarioInputs } from '../analysis/estimate';
import { formatValue } from '../domain/format';
import { buildCategories, categoryColor } from '../domain/variables';
import type { Dataset, FieldId } from '../domain/types';
import { useFrameCommit } from '../state/useFrameCommit';
import { Icon } from './Icon';
import { InfoTip } from './InfoTip';

interface Props {
  ds: Dataset;
  scenario: ScenarioInputs;
  holdTotal: boolean;
  onChange: (next: ScenarioInputs) => void;
  onHoldTotal: (v: boolean) => void;
  /** Formulation this scenario was loaded from, drawn as a ghost on each track. */
  baseline?: ScenarioInputs | null;
  /** Put every ingredient back to the baseline in one move. */
  onResetAll?: () => void;
}

/**
 * The formulation, as something you can move.
 *
 * Sliders are bounded by what the study has actually run, so the controls
 * themselves describe the explored region — pushing a value to the end of its
 * track is already the edge of the evidence. When the formulation is a closed
 * mixture the other ingredients scale to keep the total, because in a real
 * compound you cannot add five parts of anything without removing five parts of
 * something else.
 */
export function ScenarioControls({
  ds,
  scenario,
  holdTotal,
  onChange,
  onHoldTotal,
  baseline,
  onResetAll,
}: Props) {
  const cats = useMemo(() => buildCategories(ds), [ds]);
  const total = formulationTotal(ds, scenario);
  const expected = ds.mixtureTotal;
  const drift = expected === null ? 0 : total - expected;

  /**
   * How many ingredients have moved away from the formulation this scenario was
   * loaded from. Reverting one at a time is fine for a nudge, but a compound
   * that has been pulled about across six families needs one way back, and the
   * count is what tells you there is something to go back from.
   */
  const changedCount = useMemo(() => {
    if (!baseline) return 0;
    return ds.formulation.reduce((n, f) => {
      const was = baseline[f] ?? 0;
      const now = scenario[f] ?? 0;
      return n + (Math.abs(was - now) > 1e-6 ? 1 : 0);
    }, 0);
  }, [ds.formulation, baseline, scenario]);

  /**
   * The edit is computed from the scenario as it is at COMMIT time, not as it
   * was when the pointer moved, so coalescing frames can never rebalance
   * against a stale mixture.
   */
  const live = useRef(scenario);
  live.current = scenario;

  const commit = useFrameCommit(({ field, value }: { field: FieldId; value: number }) => {
    const next = { ...live.current, [field]: value };
    if (holdTotal && expected !== null && ds.formulation.includes(field)) {
      onChange(rebalance(ds, next, field, expected));
    } else {
      onChange(next);
    }
  });

  // Stable identity: a fresh arrow per row per render would defeat the memo.
  const set = useCallback((field: FieldId, value: number) => commit({ field, value }), [commit]);

  const canReset = Boolean(onResetAll) && changedCount > 0;

  return (
    <div className="scn">
      {canReset && (
        <div className="scn__edited">
          <span className="scn__editedCount">
            <span className="num">{changedCount}</span>{' '}
            {changedCount === 1 ? 'ingredient' : 'ingredients'} changed
          </span>
          <button type="button" className="scn__reset" onClick={onResetAll}>
            <Icon name="reset" size={11} />
            Reset all
          </button>
        </div>
      )}

      {expected !== null && (
        <div className={`scn__total ${Math.abs(drift) > 0.6 ? 'is-off' : ''}`}>
          <span className="scn__totalLabel">Formulation total</span>
          <span className="scn__totalVal num">{total.toFixed(1)}</span>
          <span className="scn__totalOf num">of {expected.toFixed(0)}</span>
          <InfoTip label="Why the total matters">
            <p>
              Every formulation in this study sums to {expected.toFixed(0)}, so the ingredients are
              parts of a whole rather than independent amounts. A scenario whose parts do not add up
              is not a compound anyone could weigh out.
            </p>
            <p>
              With <strong>hold total</strong> on, raising one ingredient scales the others down in
              proportion. With it off you can move one axis at a time, but the total will drift and
              the estimate will drift with it.
            </p>
          </InfoTip>
          <label className="switch">
            <input type="checkbox" checked={holdTotal} onChange={(e) => onHoldTotal(e.target.checked)} />
            <span className="switch__track" aria-hidden="true">
              <span className="switch__knob" />
            </span>
            <span className="switch__label">hold total</span>
          </label>
        </div>
      )}

      {cats.map((cat) => (
        <CategoryGroup
          key={cat.id}
          ds={ds}
          label={cat.label}
          role={cat.role}
          color={categoryColor(cat.id)}
          fields={cat.fields}
          scenario={scenario}
          baseline={baseline}
          onCommit={set}
        />
      ))}
    </div>
  );
}

/**
 * One family of ingredients.
 *
 * A formulation of twenty ingredients typically uses seven of them, and the
 * other thirteen sit at zero taking up the entire panel. So the group shows what
 * is actually in the compound and keeps the rest one click away: the common case
 * is reading and nudging what is there, and the rare case — reaching for an
 * ingredient this formulation does not use — is still one click, not a scroll
 * through thirteen empty tracks.
 */
function CategoryGroup({
  ds,
  label,
  role,
  color,
  fields,
  scenario,
  baseline,
  onCommit,
}: {
  ds: Dataset;
  label: string;
  role: string;
  color: string;
  fields: readonly FieldId[];
  scenario: ScenarioInputs;
  baseline: ScenarioInputs | null | undefined;
  onCommit: (field: FieldId, value: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const inUse = fields.filter((f) => (scenario[f] ?? 0) > 0);
  const unused = fields.length - inUse.length;
  // A family nobody is using collapses to its heading rather than vanishing —
  // it is still the way in to those ingredients.
  const shown = showAll ? fields : inUse;

  return (
    <section className="scn__cat">
      <h4 className="scn__catHead">
        <span className="scn__catDot" style={{ background: `var(${color})` }} />
        {label}
        <span className="scn__catRole">{role}</span>
        {unused > 0 && (
          <button
            type="button"
            className="scn__more"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'fewer' : `+${unused}`}
          </button>
        )}
      </h4>
      {shown.map((f) => (
        <SliderRow
          key={f}
          ds={ds}
          field={f}
          value={scenario[f] ?? 0}
          baseline={baseline?.[f]}
          color={color}
          onCommit={onCommit}
        />
      ))}
    </section>
  );
}

/**
 * One ingredient.
 *
 * Memoised because a formulation has twenty of these and a drag changes one:
 * re-rendering the other nineteen on every frame was a meaningful slice of the
 * budget that a dragging pointer does not have to spare.
 */
const SliderRow = memo(function SliderRow({
  ds,
  field,
  value,
  baseline,
  color,
  onCommit,
}: {
  ds: Dataset;
  field: FieldId;
  value: number;
  baseline: number | undefined;
  color: string;
  onCommit: (field: FieldId, value: number) => void;
}) {
  const onChange = (v: number) => onCommit(field, v);
  const meta = ds.fields.get(field)!;
  const [lo, hi] = meta.domain;
  const span = hi - lo || 1;
  const step = meta.levels ? (meta.levels[1] ?? lo + 1) - (meta.levels[0] ?? lo) : stepFor(meta.decimals);
  const pct = Math.max(0, Math.min(1, (value - lo) / span));
  const changed = baseline !== undefined && Math.abs(baseline - value) > 1e-6;

  return (
    <div className={`sld ${changed ? 'is-changed' : ''}`}>
      <label className="sld__label" htmlFor={`sld-${field}`}>
        {meta.short}
      </label>
      <div className="sld__track">
        {baseline !== undefined && (
          <span
            className="sld__ghost"
            style={{ left: `${Math.max(0, Math.min(1, (baseline - lo) / span)) * 100}%` }}
            aria-hidden="true"
          />
        )}
        <span className="sld__fill" style={{ width: `${pct * 100}%`, background: `var(${color})` }} />
        <input
          id={`sld-${field}`}
          className="sld__input"
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <input
        className="sld__num num"
        type="number"
        inputMode="decimal"
        min={lo}
        max={hi}
        step={step}
        value={round(value, meta.decimals)}
        aria-label={`${meta.label} value`}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(lo, Math.min(hi, n)));
        }}
      />
      {changed && (
        <button
          type="button"
          className="sld__revert"
          onClick={() => onChange(baseline!)}
          aria-label={`Reset ${meta.short} to ${formatValue(baseline!, meta.decimals)}`}
          title={`Back to ${formatValue(baseline!, meta.decimals)}`}
        >
          <Icon name="reset" size={11} />
        </button>
      )}
    </div>
  );
});

const stepFor = (decimals: number) => (decimals <= 0 ? 1 : decimals === 1 ? 0.1 : 0.01);
const round = (v: number, d: number) => Number(v.toFixed(Math.min(d, 3)));
