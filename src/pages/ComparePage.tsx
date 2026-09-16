import { useMemo, useState } from 'react';
import { summariseTarget } from '../analysis/target';
import { Empty, PageHead, Section } from '../components/Bits';
import { amountsOf, CompositionBar } from '../components/Formulation';
import { Icon } from '../components/Icon';
import { formatValue } from '../domain/format';
import { categoryColor, categoryLabel, categoryOf } from '../domain/variables';
import type { Dataset, FieldId } from '../domain/types';
import type { AppState } from '../state/appState';
import type { Route } from '../state/router';
import type { Update } from '../state/store';

interface Props {
  ds: Dataset;
  state: AppState;
  update: Update;
  navigate: (route: Route) => void;
}

interface Delta {
  field: FieldId;
  label: string;
  a: number;
  b: number;
  delta: number;
  /** |delta| as a fraction of the field's observed span — lets shelves be ranked together. */
  weight: number;
}

/** Below this share of a variable's range, a difference is noise on the bench. */
const NOISE = 0.02;

/**
 * Two experiments produced different results. What changed?
 *
 * The answer is the delta, so the delta is what the page leads with: inputs that
 * moved, largest first, then outputs that moved. Side-by-side columns make you do
 * the subtraction yourself across nineteen rows, most of which are identical.
 */
export function ComparePage({ ds, state, update, navigate }: Props) {
  const [showAll, setShowAll] = useState(false);
  const picked = state.selection
    .map((id) => ds.experiments.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));

  const outcome = useMemo(() => summariseTarget(ds, state.target), [ds, state.target]);

  const [a, b] = picked;

  const deltas = useMemo(() => {
    if (!a || !b) return { inputs: [] as Delta[], outputs: [] as Delta[] };
    const build = (fields: readonly FieldId[]): Delta[] =>
      fields
        .map((f) => {
          const meta = ds.fields.get(f)!;
          const col = ds.columns.get(f)!;
          const va = col[a.index] ?? 0;
          const vb = col[b.index] ?? 0;
          const span = meta.domain[1] - meta.domain[0];
          return {
            field: f,
            label: meta.short,
            a: va,
            b: vb,
            delta: vb - va,
            weight: span > 0 ? Math.abs(vb - va) / span : 0,
          };
        })
        .sort((x, y) => y.weight - x.weight);
    return {
      inputs: build([...ds.formulation, ...ds.process]),
      outputs: build(ds.outputs),
    };
  }, [ds, a, b]);

  if (picked.length < 2) {
    return (
      <div className="page page--narrow">
        <PageHead title="Compare" purpose="These experiments produced different results. What changed?" />
        <Empty
          icon="columns"
          title={picked.length === 0 ? 'Nothing selected yet.' : 'One more to go.'}
          body={
            picked.length === 0
              ? 'Pick two experiments from the target results or the experiments table, and this page will show exactly what differed between them.'
              : `${picked[0]?.id} is selected. Pick a second experiment to compare it against.`
          }
          action={
            <button type="button" className="btn btn--primary" onClick={() => navigate({ name: 'experiments' })}>
              Choose experiments <Icon name="arrow" size={13} />
            </button>
          }
        />
      </div>
    );
  }

  const changedInputs = deltas.inputs.filter((d) => d.weight > NOISE);
  const unchangedCount = deltas.inputs.length - changedInputs.length;
  const inputsShown = showAll ? deltas.inputs : changedInputs;
  const maxInput = Math.max(...deltas.inputs.map((d) => d.weight), 0.001);
  const maxOutput = Math.max(...deltas.outputs.map((d) => d.weight), 0.001);

  return (
    <div className="page">
      <PageHead title="Compare" purpose="These experiments produced different results. What changed?">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => update((s) => ({ ...s, selection: [] }))}>
          Clear selection
        </button>
      </PageHead>

      <div className="cmpHead">
        {[a!, b!].map((e, i) => {
          const m = outcome.matches.find((x) => x.id === e.id);
          return (
            <div key={e.id} className={`cmpHead__col cmpHead__col--${i === 0 ? 'a' : 'b'}`}>
              <span className="cmpHead__tag">{i === 0 ? 'from' : 'to'}</span>
              <button type="button" className="cmpHead__id mono" onClick={() => navigate({ name: 'experiment', id: e.id })}>
                {e.id}
              </button>
              {m && m.activeCount > 0 && (
                <span className={`mini ${m.satisfiesAll ? 'is-met' : 'is-miss'}`}>
                  {m.satisfiesAll ? 'meets the target' : `${m.satisfiedCount}/${m.activeCount} constraints`}
                </span>
              )}
              <CompositionBar ds={ds} amounts={amountsOf(ds, e.index)} height={8} />
            </div>
          );
        })}
      </div>

      <div className="split split--even">
        <Section
          title="What changed in the formulation"
          note={`${changedInputs.length} of ${deltas.inputs.length} inputs differ`}
        >
          {changedInputs.length === 0 ? (
            <Empty icon="info" title="Identical inputs." body="These two experiments used the same formulation and the same process settings." />
          ) : (
            <ul className="dl">
              {inputsShown.map((d) => (
                <DeltaRow key={d.field} ds={ds} d={d} max={maxInput} />
              ))}
            </ul>
          )}
          {unchangedCount > 0 && (
            <button type="button" className="linkbtn dl__toggle" onClick={() => setShowAll((v) => !v)}>
              {showAll ? `Hide ${unchangedCount} unchanged inputs` : `Show ${unchangedCount} unchanged inputs`}
            </button>
          )}
        </Section>

        <Section title="What changed in the results" note="measured">
          <ul className="dl dl--out">
            {deltas.outputs.map((d) => (
              <DeltaRow key={d.field} ds={ds} d={d} max={maxOutput} isOutput />
            ))}
          </ul>
          <p className="note note--plain">
            These two experiments differ on {changedInputs.length}{' '}
            {changedInputs.length === 1 ? 'input' : 'inputs'} at once, so no single change can be
            credited with any of these differences.
          </p>
        </Section>
      </div>
    </div>
  );
}

function DeltaRow({
  ds,
  d,
  max,
  isOutput = false,
}: {
  ds: Dataset;
  d: Delta;
  max: number;
  isOutput?: boolean;
}) {
  const meta = ds.fields.get(d.field)!;
  const cat = categoryOf(meta, meta.family);
  const pct = max > 0 ? Math.min(1, d.weight / max) : 0;
  const zero = Math.abs(d.delta) < 1e-9;
  return (
    <li className={`dl__row ${zero ? 'is-flat' : d.delta > 0 ? 'is-up' : 'is-down'}`}>
      {!isOutput && (
        <span className="dl__cat" style={{ background: `var(${categoryColor(cat)})` }} title={categoryLabel(cat)} />
      )}
      <span className="dl__name">{isOutput ? meta.label : d.label}</span>
      <span className="dl__from num">{formatValue(d.a, meta.decimals)}</span>
      <span className="dl__arrow" aria-hidden="true">
        →
      </span>
      <span className="dl__to num">{formatValue(d.b, meta.decimals)}</span>
      <span className="dl__bar" aria-hidden="true">
        <span className="dl__barMid" />
        {!zero && (
          <span
            className="dl__barFill"
            style={{
              width: `${(pct * 50).toFixed(1)}%`,
              left: d.delta > 0 ? '50%' : undefined,
              right: d.delta < 0 ? '50%' : undefined,
            }}
          />
        )}
      </span>
      <span className="dl__delta num">
        {zero ? '—' : `${d.delta > 0 ? '+' : '−'}${formatValue(Math.abs(d.delta), meta.decimals)}`}
      </span>
    </li>
  );
}
