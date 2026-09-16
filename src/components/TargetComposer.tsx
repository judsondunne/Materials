import { useMemo } from 'react';
import {
  suggestConstraint,
  type ConstraintKind,
  type TargetConstraint,
  type TargetProfile,
} from '../analysis/target';
import { describe } from '../analysis/stats';
import { formatValue } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import { DistStrip } from './DistStrip';
import { Icon } from './Icon';
import { InfoTip } from './InfoTip';

const MODES: { kind: ConstraintKind | 'off'; label: string; hint: string }[] = [
  { kind: 'off', label: 'any', hint: 'Do not constrain this property' },
  { kind: 'atLeast', label: '≥', hint: 'At least this value' },
  { kind: 'atMost', label: '≤', hint: 'At most this value' },
  { kind: 'between', label: '–', hint: 'Between two values' },
  { kind: 'approx', label: '≈', hint: 'Close to a value' },
];

interface Props {
  ds: Dataset;
  target: TargetProfile;
  rows: readonly number[];
  onChange: (next: TargetProfile) => void;
  /** How many experiments currently satisfy each property's own constraint. */
  metPerProperty?: Map<FieldId, number>;
}

/**
 * Where the investigation starts: the properties the material has to have.
 *
 * Every property is optional and every one shows the distribution it is being
 * measured against, because a specification typed without seeing the observed
 * range is a guess. Nothing is pre-filled — an empty form is honest — but each
 * row can be seeded from the study's own upper or lower quartile in one click.
 */
export function TargetComposer({ ds, target, rows, onChange, metPerProperty }: Props) {
  return (
    <div className="tc">
      <div className="tc__head">
        <span className="tc__headProp">Property</span>
        <span className="tc__headMode">Constraint</span>
        <span className="tc__headDist">
          Observed across {rows.length} experiments
          <InfoTip label="Reading the strip">
            <p>
              Each bar counts experiments falling in that slice of the property's observed range.
              The shaded band is the span your constraint would accept, so you can see whether you
              have asked for something this study reaches often, rarely, or never.
            </p>
          </InfoTip>
        </span>
      </div>

      {ds.outputs.map((id) => (
        <ConstraintRow
          key={id}
          ds={ds}
          property={id}
          rows={rows}
          constraint={target[id] ?? null}
          met={metPerProperty?.get(id)}
          onSet={(c) => {
            const next = { ...target };
            if (c) next[id] = c;
            else delete next[id];
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

function ConstraintRow({
  ds,
  property,
  rows,
  constraint,
  met,
  onSet,
}: {
  ds: Dataset;
  property: FieldId;
  rows: readonly number[];
  constraint: TargetConstraint | null;
  met: number | undefined;
  onSet: (c: TargetConstraint | null) => void;
}) {
  const meta = ds.fields.get(property)!;
  const col = ds.columns.get(property)!;
  const stats = useMemo(() => describe(col, rows), [col, rows]);
  const fmt = (v: number) => formatValue(v, meta.decimals);
  const step = stepFor(meta.decimals);

  const region: [number, number] | null = constraint
    ? [
        constraint.kind === 'atMost'
          ? meta.domain[0] - 1
          : constraint.kind === 'approx'
            ? (constraint.value ?? 0) - Math.abs(constraint.tolerance ?? 0)
            : (constraint.min ?? meta.domain[0]),
        constraint.kind === 'atLeast'
          ? meta.domain[1] + 1
          : constraint.kind === 'approx'
            ? (constraint.value ?? 0) + Math.abs(constraint.tolerance ?? 0)
            : (constraint.max ?? meta.domain[1]),
      ]
    : null;

  const active = constraint !== null;

  return (
    <div className={`tcr ${active ? 'is-active' : ''}`}>
      <div className="tcr__prop">
        <span className="tcr__name">{meta.label}</span>
        <span className="tcr__range num">
          {fmt(stats.min)}–{fmt(stats.max)}
        </span>
      </div>

      <div className="tcr__controls">
        <div className="seg seg--sm" role="group" aria-label={`${meta.label} constraint type`}>
          {MODES.map((m) => {
            const on = m.kind === 'off' ? !active : constraint?.kind === m.kind;
            return (
              <button
                key={m.kind}
                type="button"
                className={`seg__b ${on ? 'is-on' : ''}`}
                aria-pressed={on}
                title={m.hint}
                onClick={() =>
                  onSet(m.kind === 'off' ? null : suggestConstraint(ds, property, m.kind))
                }
              >
                {m.label}
              </button>
            );
          })}
        </div>

        {constraint && (
          <div className="tcr__inputs">
            {(constraint.kind === 'atLeast' || constraint.kind === 'between') && (
              <NumField
                label={constraint.kind === 'between' ? 'from' : 'min'}
                value={constraint.min}
                step={step}
                onChange={(v) => onSet({ ...constraint, min: v })}
              />
            )}
            {(constraint.kind === 'atMost' || constraint.kind === 'between') && (
              <NumField
                label={constraint.kind === 'between' ? 'to' : 'max'}
                value={constraint.max}
                step={step}
                onChange={(v) => onSet({ ...constraint, max: v })}
              />
            )}
            {constraint.kind === 'approx' && (
              <>
                <NumField
                  label="value"
                  value={constraint.value}
                  step={step}
                  onChange={(v) => onSet({ ...constraint, value: v })}
                />
                <NumField
                  label="±"
                  value={constraint.tolerance}
                  step={step}
                  onChange={(v) => onSet({ ...constraint, tolerance: Math.abs(v) })}
                />
              </>
            )}
            <button
              type="button"
              className="tcr__clear"
              onClick={() => onSet(null)}
              aria-label={`Stop constraining ${meta.label}`}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        )}
      </div>

      <div className="tcr__dist">
        <DistStrip ds={ds} field={property} rows={rows} region={region} />
        <span className={`tcr__met ${met === 0 ? 'is-none' : ''}`}>
          {constraint
            ? met === undefined
              ? ''
              : met === 0
                ? 'no experiment reaches this'
                : `${met} of ${rows.length} meet it`
            : 'not constrained'}
        </span>
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number | undefined;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="numf">
      <span className="numf__label">{label}</span>
      <input
        className="numf__input num"
        type="number"
        inputMode="decimal"
        step={step}
        value={value ?? ''}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}

const stepFor = (decimals: number) => (decimals <= 0 ? 1 : decimals === 1 ? 0.1 : 0.01);
