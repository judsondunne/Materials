import { describeConstraint } from '../../analysis/target';
import { formatValue } from '../../domain/format';
import type { ProductProgram, RequirementCheck } from '../../product/types';
import { Icon } from '../Icon';
import { MarginBar } from './Safety';
import { InfoTip } from '../InfoTip';

/**
 * The design requirements, and whether the formulation on screen meets them.
 *
 * A tick is a MEASUREMENT satisfying a requirement; a tilde is an ESTIMATE
 * satisfying one. They are never drawn the same, because the difference between
 * "this run achieved it" and "we expect this to achieve it" is the difference
 * between evidence and a hypothesis.
 */

export function RequirementRows({
  checks,
  showWhy = false,
}: {
  checks: readonly RequirementCheck[];
  showWhy?: boolean;
}) {
  return (
    <ul className="req">
      {checks.map((check) => {
        const r = check.requirement;
        const e = check.evaluation;
        const has = Number.isFinite(e.value);
        return (
          <li
            key={r.property}
            className={`req__row ${e.satisfied ? 'is-met' : 'is-miss'} ${
              check.measured ? 'is-measured' : 'is-estimated'
            } req__row--${r.role}`}
          >
            <span className="req__mark" aria-hidden="true">
              {e.satisfied ? (
                check.measured ? (
                  <Icon name="check" size={12} />
                ) : (
                  <span className="req__tilde">~</span>
                )
              ) : (
                <Icon name="close" size={10} />
              )}
            </span>
            <span className="req__name">
              {r.label}
              {showWhy && (
                <InfoTip label={`Why this ${r.role === 'primary' ? 'requirement' : 'preference'}`}>
                  <p>{r.why}</p>
                  <p className="tip__foot">
                    Demo design requirement. The bound is the{' '}
                    {Array.isArray(r.quantile)
                      ? `${pct(r.quantile[0])}–${pct(r.quantile[1])} quantiles`
                      : `${pct(r.quantile)} quantile`}{' '}
                    of this property's measured distribution across the study, so it is demanding
                    but inside what has actually been achieved. Observed range{' '}
                    {formatValue(r.observed[0], r.decimals)}–{formatValue(r.observed[1], r.decimals)}
                    ; {r.metAlone} of the experiments meet it on its own.
                  </p>
                </InfoTip>
              )}
            </span>
            <span className={`req__value num ${check.measured ? '' : 'is-est'}`}>
              {!check.measured && has && <span className="req__estMark">~</span>}
              {has ? formatValue(e.value, r.decimals) : '—'}
            </span>
            <span className="req__target num">
              {describeConstraint(r.constraint, (v) => formatValue(v, r.decimals))}
            </span>
            {/* Same scale as the gauge above, so "passes" and "passes by how
                much" are one glance rather than two. */}
            {has && <MarginBar margin={e.margin} label={r.short} />}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * How far through the brief this compound is, as a progress check.
 *
 * It used to be a fraction beside two lines of prose counting the same things
 * again in words. Now the ring IS the count: it fills as requirements are met
 * and closes green when the brief is clear, and one run of segments underneath
 * says which are outstanding. The two roles are separated by a gap and by
 * segment width rather than by labels, which at this size shouted louder than
 * the marks they were labelling.
 */
export function RequirementSummary({
  checks,
  program,
}: {
  checks: readonly RequirementCheck[];
  program: ProductProgram;
}) {
  const met = checks.filter((c) => c.evaluation.satisfied).length;
  const total = checks.length;
  const primary = checks.filter((c) => c.requirement.role === 'primary');
  const process = checks.filter((c) => c.requirement.role === 'process');
  const all = met === total && total > 0;

  // An SVG ring rather than a bar: at this size a ring reads as a completion
  // state, where a 40px bar reads as nothing at all.
  const R = 15;
  const C = 2 * Math.PI * R;
  const done = total > 0 ? met / total : 0;

  return (
    <div className={`reqsum ${all ? 'is-all' : ''}`}>
      <span className="reqsum__ring" aria-hidden="true">
        <svg viewBox="0 0 36 36">
          <circle className="reqsum__ringTrack" cx="18" cy="18" r={R} />
          <circle
            className="reqsum__ringFill"
            cx="18"
            cy="18"
            r={R}
            strokeDasharray={`${C * done} ${C}`}
          />
        </svg>
        {/* A closed ring around a number reads as a badge, not as a finished
            job. Once the brief is clear the number is in the sentence anyway,
            so the middle becomes a tick. */}
        <span className="reqsum__ringMark">
          {all ? <Icon name="check" size={13} /> : <span className="num">{met}</span>}
        </span>
      </span>

      <span className="reqsum__body">
        <span className="reqsum__head">
          {all ? 'All requirements met' : `${met} of ${total} met`}
        </span>
        {/* Grouped by a gap rather than by two uppercase labels. At this size
            the words were louder than the marks they were labelling, and the
            shorter segments already read as the lesser category. */}
        <span className="reqsum__segs">
          {primary.map((c) => (
            <Seg key={c.requirement.property} check={c} />
          ))}
          {process.length > 0 && <span className="reqsum__gap" aria-hidden="true" />}
          {process.map((c) => (
            <Seg key={c.requirement.property} check={c} process />
          ))}
        </span>
      </span>

      <span className="sr-only">for the {program.spec.name} demo design requirements</span>
    </div>
  );
}

/** One requirement. The tooltip carries the name, so the row needs no labels. */
function Seg({ check, process = false }: { check: RequirementCheck; process?: boolean }) {
  const met = check.evaluation.satisfied;
  return (
    <span
      className={`reqsum__seg ${met ? 'is-met' : ''} ${process ? 'is-process' : ''}`}
      title={`${check.requirement.label} (${process ? 'process' : 'performance'}): ${
        met ? 'met' : 'not met'
      }`}
    />
  );
}

const pct = (q: number) => `${Math.round(q * 100)}th`;
