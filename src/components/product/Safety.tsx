import type { RequirementCheck } from '../../product/types';
import { InfoTip } from '../InfoTip';

/**
 * How much room is left before a requirement stops being met.
 *
 * "Does it pass" is a tick, and a tick tells you nothing about whether it passes
 * by a mile or by a hair — which is the difference between a compound you can
 * hand to production and one that will fail the first time a batch drifts. So
 * every requirement also gets a position on one shared scale: clear on the
 * left, through a narrowing amber band, to past the bound on the right.
 *
 * ─── WHAT THE RED END IS, AND IS NOT ─────────────────────────────────────────
 * The right-hand end is the DESIGN REQUIREMENT's bound, not a physical failure
 * point. Nothing in this study establishes a load, a temperature or an age at
 * which any of these compounds breaks — there is no fatigue, ageing or failure
 * data in the file. Red means "outside what this brief asks for", which is a
 * statement about the brief. The scale is labelled in those words for that
 * reason, and never as "failure".
 */

/**
 * Slack, as a fraction of the property's observed span, at which a requirement
 * counts as comfortably clear.
 *
 * An eighth of everything the study has ever shown for that property is a wide
 * berth by this dataset's own standards. Set at a fifth this read as amber for
 * requirements passing by a mile, which trains people to ignore the colour —
 * the one thing a safety scale must not do.
 */
const CLEAR_AT = 0.125;

/** Slack below which it is close enough to the bound to be worth flagging. */
const TIGHT_AT = 0.05;

export type Band = 'clear' | 'tight' | 'edge' | 'over';

export function bandOf(margin: number): Band {
  if (!Number.isFinite(margin)) return 'over';
  if (margin < 0) return 'over';
  if (margin < TIGHT_AT / 2) return 'edge';
  if (margin < CLEAR_AT) return 'tight';
  return 'clear';
}

const BAND_WORD: Record<Band, string> = {
  clear: 'Clear',
  tight: 'Getting tight',
  edge: 'On the bound',
  over: 'Outside the brief',
};

/**
 * Where a margin sits on the 0–1 scale the bar is drawn on.
 *
 * Left is a wide berth, 0.72 is exactly on the bound, and the last quarter is
 * how far outside it has gone. Fixing the bound at 0.72 rather than at the end
 * keeps "over" visible as its own stretch instead of a value pinned to the edge.
 */
const AT_BOUND = 0.72;

export function positionOf(margin: number): number {
  if (!Number.isFinite(margin)) return 1;
  if (margin >= 0) {
    const clear = Math.min(1, margin / CLEAR_AT);
    return AT_BOUND * (1 - clear);
  }
  const over = Math.min(1, -margin / 0.15);
  return AT_BOUND + (1 - AT_BOUND) * over;
}

/**
 * The headline: one bar for the whole compound, positioned by its WORST
 * requirement. A formulation is only as safe as the requirement it is closest to
 * losing, so an average here would flatter it.
 */
export function SafetyGauge({ checks }: { checks: readonly RequirementCheck[] }) {
  const active = checks.filter((c) => Number.isFinite(c.evaluation.margin));
  if (active.length === 0) return null;

  const worst = active.reduce((a, b) => (b.evaluation.margin < a.evaluation.margin ? b : a));
  const band = bandOf(worst.evaluation.margin);
  const pos = positionOf(worst.evaluation.margin);

  return (
    <div className={`gauge is-${band}`}>
      <div className="gauge__top">
        <span className="gauge__verdict">{BAND_WORD[band]}</span>
        <span className="gauge__by">
          {band === 'over' ? 'missing' : 'tightest on'} {worst.requirement.short}
        </span>
        <InfoTip label="Margin to the requirement">
          <p>
            How much room is left before a requirement stops being met, taken on the worst of them.
            The bar runs from a wide berth on the left, to the bound itself, and then past it.
          </p>
          <p>
            "Wide" means slack of an eighth of that property's observed range across the study —
            the only yardstick this data supports.
          </p>
          <p className="tip__foot">
            The right-hand end is the design brief's bound, not a failure point. This study contains
            no fatigue, ageing or failure data, so nothing here says at what load or age any of
            these compounds would break.
          </p>
        </InfoTip>
      </div>

      <div className="gauge__bar">
        <span className="gauge__zone gauge__zone--clear" />
        <span className="gauge__zone gauge__zone--tight" />
        <span className="gauge__zone gauge__zone--over" />
        <span className="gauge__mark" style={{ left: `${pos * 100}%` }}>
          <span className="gauge__markDot" />
        </span>
      </div>

      <div className="gauge__scale">
        <span>clear</span>
        <span className="gauge__scaleMid">on the bound</span>
        <span>outside</span>
      </div>
    </div>
  );
}

/**
 * Headroom left on one requirement, as a slim track.
 *
 * The bar is how much room REMAINS, not how far along some scale the value has
 * travelled: a long bar is a comfortable requirement and a short one is a
 * requirement about to be lost. That is the direction people already read a
 * bar in, and the earlier version — which grew as the margin shrank — meant a
 * reassuringly full track was the alarming case.
 *
 * Past the bound there is no headroom to draw, so the whole track turns red.
 * Length stops carrying meaning there and colour takes over, which is the
 * honest thing: "outside" has no degrees worth drawing at this size.
 */
export function MarginBar({ margin, label }: { margin: number; label: string }) {
  const band = bandOf(margin);
  const headroom = margin >= 0 ? Math.min(1, margin / CLEAR_AT) : 1;
  return (
    <span className={`mbar is-${band}`} title={`${label}: ${BAND_WORD[band].toLowerCase()}`}>
      <span className="mbar__fill" style={{ width: `${Math.max(headroom, 0.04) * 100}%` }} />
    </span>
  );
}
