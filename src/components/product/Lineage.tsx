import type { ReactNode } from 'react';
import type { SupportLevel } from '../../analysis/estimate';
import { SUPPORT_COPY } from '../../analysis/estimate';
import { SEVERITY_COPY, type Severity } from '../../product/behavior';
import { Icon } from '../Icon';
import { InfoTip } from '../InfoTip';

/**
 * Provenance, worn lightly.
 *
 * Three badges, one for each kind of thing this application can tell you, small
 * enough to sit in a heading without shouting. Nothing is hidden behind them —
 * each one carries the full explanation a click away — but the page does not
 * open with a wall of disclaimers either.
 */

export type Lineage = 'historical' | 'estimated' | 'custom';

const COPY: Record<Lineage, { label: string; title: string; body: string }> = {
  historical: {
    label: 'Historical',
    title: 'Historical data',
    body: 'A formulation that was actually made and measured. Every number shown for it is a measurement read from the supplied experimental dataset.',
  },
  estimated: {
    label: 'Estimated',
    title: 'Data-based estimate',
    body: 'A formulation nobody has made. Its properties come from the scenario estimator — a weighted average of the nearest real experiments — and carry a historical support level. They are estimates, not results.',
  },
  custom: {
    label: 'Your edit',
    title: 'Edited formulation',
    body: 'You have changed this formulation by hand. Its properties are estimated from the nearest real experiments, exactly as any other untested formulation would be.',
  },
};

export function LineageBadge({ kind, compact = false }: { kind: Lineage; compact?: boolean }) {
  const copy = COPY[kind];
  return (
    <span className={`lin lin--${kind} ${compact ? 'lin--compact' : ''}`}>
      <span className="lin__label">{copy.label}</span>
      {!compact && (
        <InfoTip label={copy.title}>
          <p>{copy.body}</p>
        </InfoTip>
      )}
    </span>
  );
}

/** Support for an estimate, as a chip. */
export function SupportChip({ level }: { level: SupportLevel }) {
  const copy = SUPPORT_COPY[level];
  return (
    <span className={`supchip supchip--${level}`} title={copy.detail}>
      <Icon name={level === 'high' ? 'check' : level === 'moderate' ? 'info' : 'warn'} size={11} />
      {level === 'high' ? 'High support' : level === 'moderate' ? 'Moderate support' : 'Low support'}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: Severity }) {
  const copy = SEVERITY_COPY[severity];
  return (
    <span className={`sev sev--${severity}`}>
      <span className="sev__dot" aria-hidden="true" />
      <span className="sev__label">{copy.label}</span>
      <InfoTip label="Simulated loading">
        <p>{copy.detail}</p>
        <p>
          The bands are a property of this demonstration model, not of the compound. Nothing in the
          supplied dataset establishes a load at which any of these components would fail.
        </p>
      </InfoTip>
    </span>
  );
}

/** A heading with its provenance attached, used at the top of every product panel. */
export function PanelHead({
  title,
  lineage,
  note,
  children,
}: {
  title: string;
  lineage?: Lineage;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <div className="pnl__head">
      <h3 className="pnl__title">
        {title}
        {lineage && <LineageBadge kind={lineage} />}
      </h3>
      {note && <p className="pnl__note">{note}</p>}
      {children}
    </div>
  );
}
