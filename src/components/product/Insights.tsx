import { formatValue } from '../../domain/format';
import type { Dataset, FieldId } from '../../domain/types';
import { BEHAVIOR_TOOLTIP, type MaterialBehavior } from '../../product/behavior';
import type { ProductProgram } from '../../product/types';
import { Disclosure } from '../Disclosure';
import { InfoTip } from '../InfoTip';

/**
 * What the five measured properties MEAN for this part.
 *
 * Not "simulation metrics". The same five numbers appear on every screen in this
 * application; what changes between an O-ring and a hose is why you would care
 * about them, and that is what this panel carries.
 */
export function InsightPanel({
  ds,
  program,
  values,
  measured,
  behavior,
}: {
  ds: Dataset;
  program: ProductProgram;
  values: Record<FieldId, number>;
  measured: boolean;
  behavior: MaterialBehavior;
}) {
  return (
    <div className="ins">
      {program.spec.insight.map((group) => (
        <section key={group.title} className="ins__group">
          <h4 className="ins__title">{group.title}</h4>
          <ul className="ins__list">
            {group.lines.map((line) => {
              const property = ds.outputs.find((o) => line.match.test(o));
              const meta = property ? ds.fields.get(property) : undefined;
              const value = property ? values[property] : undefined;
              if (!meta || value === undefined || !Number.isFinite(value)) return null;
              const [lo, hi] = meta.domain;
              const pos = hi > lo ? ((value - lo) / (hi - lo)) * 100 : 50;
              return (
                <li key={line.label} className="ins__row">
                  <span className="ins__label">{line.label}</span>
                  <span className={`ins__value num ${measured ? '' : 'is-est'}`}>
                    {!measured && '~'}
                    {formatValue(value, meta.decimals)}
                  </span>
                  <span className="ins__scale" aria-hidden="true">
                    <span className="ins__tick" style={{ left: `${Math.max(0, Math.min(100, pos))}%` }} />
                  </span>
                  <span className="ins__note">{line.note}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <Disclosure summary="How material properties drive what you see" tone="method">
        <p>{BEHAVIOR_TOOLTIP}</p>
        <table className="method__table">
          <thead>
            <tr>
              <th>Measured property</th>
              <th>Position in observed range</th>
              <th>What it drives on screen</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{behavior.drivers.deformability?.label ?? 'Elongation'}</td>
              <td className="num">
                {behavior.drivers.deformability
                  ? `${Math.round(behavior.drivers.deformability.normalised * 100)}%`
                  : '—'}
              </td>
              <td>
                Deformation amplitude ×{behavior.amplitude.toFixed(2)}
              </td>
            </tr>
            <tr>
              <td>{behavior.drivers.integrity?.label ?? 'Tensile strength'}</td>
              <td className="num">
                {behavior.drivers.integrity
                  ? `${Math.round(behavior.drivers.integrity.normalised * 100)}%`
                  : '—'}
              </td>
              <td>Field divided by {behavior.tolerance.toFixed(2)}</td>
            </tr>
            <tr>
              <td>{behavior.drivers.recovery?.label ?? 'Compression set'}</td>
              <td className="num">
                {behavior.drivers.recovery
                  ? `${Math.round(behavior.drivers.recovery.normalised * 100)}%`
                  : '—'}
              </td>
              <td>{Math.round(behavior.residualFraction * 100)}% of a squeeze retained</td>
            </tr>
            {behavior.process.map((p) => (
              <tr key={p.property}>
                <td>{p.label}</td>
                <td className="num">{Math.round(p.normalised * 100)}%</td>
                <td>Process characteristic — not applied to the mechanics</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          These are normalisations chosen for the demonstration, not constitutive relationships.
          There is no modulus, no Poisson's ratio and no stress–strain curve in the supplied
          dataset, so nothing here could be calibrated against a measurement even in principle.
        </p>
      </Disclosure>

      <Disclosure summary={`What a production ${program.spec.noun} programme would also measure`}>
        <p>
          This study measures five properties. Developing this part for real would need at least the
          following, none of which is present here — so the application never implies it has them:
        </p>
        <ul className="ins__missing">
          {program.spec.missingMeasurements.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

/** The two process properties, as a manufacturing read-out rather than mechanics. */
export function ProcessReadout({ behavior, measured }: { behavior: MaterialBehavior; measured: boolean }) {
  if (behavior.process.length === 0) return null;
  return (
    <div className="prc">
      <span className="prc__head">
        Process
        <InfoTip label="Process characteristics">
          <p>
            Viscosity and cure time describe how the compound behaves in the factory. They are
            reported here and checked against the program's process preferences, and they are
            deliberately not applied to the component's mechanical behaviour.
          </p>
        </InfoTip>
      </span>
      {behavior.process.map((p) => (
        <span key={p.property} className="prc__item">
          <span className="prc__name">{p.short}</span>
          <span className={`prc__val num ${measured ? '' : 'is-est'}`}>
            {!measured && '~'}
            {formatValue(p.value, p.decimals)}
          </span>
        </span>
      ))}
    </div>
  );
}
