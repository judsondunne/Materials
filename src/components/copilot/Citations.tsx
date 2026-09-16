import { useState } from 'react';
import { formatValue } from '../../domain/format';
import type { Dataset } from '../../domain/types';
import type { Citation } from '../../ai/protocol';
import { Icon } from '../Icon';

/**
 * Evidence, as something you can click.
 *
 * Every substantive number the assistant states should be traceable to the run
 * it came from, and a chip is the shortest path: hovering shows the exact values
 * behind the claim, clicking takes you to them and highlights them in whatever
 * chart is on screen. This is what separates "some experiments look strong" from
 * a citation a scientist can check.
 *
 * The four chip types mirror the four kinds of claim, and they are styled apart
 * on purpose: an estimate must never be mistaken for a measurement.
 */

interface Props {
  ds: Dataset;
  citations: Citation[];
  onOpenExperiment: (id: string) => void;
  onHighlight: (ids: string[], reason: string) => void;
}

const shortId = (id: string) => {
  const m = /EXP[_-]?(\d+)/i.exec(id);
  return m ? `EXP ${m[1]}` : id.slice(-7);
};

export function Citations({ ds, citations, onOpenExperiment, onHighlight }: Props) {
  if (citations.length === 0) return null;
  return (
    <div className="cp__cites">
      {citations.map((c, i) => (
        <Chip
          key={`${c.type}-${i}`}
          ds={ds}
          citation={c}
          onOpenExperiment={onOpenExperiment}
          onHighlight={onHighlight}
        />
      ))}
    </div>
  );
}

function Chip({
  ds,
  citation,
  onOpenExperiment,
  onHighlight,
}: {
  ds: Dataset;
  citation: Citation;
  onOpenExperiment: (id: string) => void;
  onHighlight: (ids: string[], reason: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const body = (() => {
    switch (citation.type) {
      case 'experiment':
        return (
          <>
            <span className="cp__citeId mono">{shortId(citation.experimentId)}</span>
            <Popover open={open} title={citation.experimentId}>
              <dl className="cp__vals">
                {citation.fields
                  .filter((f) => Number.isFinite(f.value))
                  .filter((f) => f.role === 'output' || f.value > 0)
                  .slice(0, 9)
                  .map((f) => (
                    <div key={f.field} className={f.role === 'output' ? 'is-output' : ''}>
                      <dt>{ds.fields.get(f.field)?.short ?? f.field}</dt>
                      <dd className="num">{formatValue(f.value, f.decimals)}</dd>
                    </div>
                  ))}
              </dl>
              <p className="cp__popFoot">measured · click to open</p>
            </Popover>
          </>
        );

      case 'cohort':
        return (
          <>
            <Icon name="layers" size={11} />
            <span className="cp__citeId">
              {citation.experimentIds.length} experiment{citation.experimentIds.length === 1 ? '' : 's'}
            </span>
            <Popover open={open} title={citation.label}>
              <p className="cp__popDef">{citation.definition}</p>
              <p className="cp__popIds mono">{citation.experimentIds.map(shortId).join(' · ')}</p>
              <p className="cp__popFoot">click to highlight them</p>
            </Popover>
          </>
        );

      case 'analysis':
        return (
          <>
            <Icon name="chart" size={11} />
            <span className="cp__citeId">
              {citation.statistic} {citation.value >= 0 ? '+' : '−'}
              {Math.abs(citation.value).toFixed(2)}
            </span>
            <Popover open={open} title={citation.label}>
              <p className="cp__popDef">{citation.detail}</p>
              <p className="cp__popFoot">computed across {citation.n} experiments · observed association</p>
            </Popover>
          </>
        );

      case 'estimate':
        return (
          <>
            <Icon name="cube" size={11} />
            <span className="cp__citeId">estimate</span>
            <Popover open={open} title={citation.label}>
              <dl className="cp__vals">
                {citation.values.map((v) => (
                  <div key={v.property} className="is-output">
                    <dt>{ds.fields.get(v.property)?.short ?? v.property}</dt>
                    <dd className="num">~{formatValue(v.value, v.decimals)}</dd>
                  </div>
                ))}
              </dl>
              <p className="cp__popDef">
                Weighted from{' '}
                {citation.neighbours
                  .slice(0, 3)
                  .map((n) => `${shortId(n.experimentId)} (${Math.round(n.weight * 100)}%)`)
                  .join(', ')}
              </p>
              <p className="cp__popFoot">estimated, not measured · support {citation.support}</p>
            </Popover>
          </>
        );
    }
  })();

  const act = () => {
    if (citation.type === 'experiment') {
      onHighlight([citation.experimentId], 'cited');
      onOpenExperiment(citation.experimentId);
    } else if (citation.type === 'cohort') {
      onHighlight(citation.experimentIds, citation.label);
    } else if (citation.type === 'estimate') {
      onHighlight(citation.neighbours.map((n) => n.experimentId), 'supports the estimate');
    }
  };

  const clickable = citation.type !== 'analysis';

  return (
    <button
      type="button"
      className={`cp__cite cp__cite--${citation.type} ${clickable ? '' : 'is-static'}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={clickable ? act : undefined}
      aria-label={
        citation.type === 'experiment'
          ? `Evidence from ${citation.experimentId}`
          : citation.type === 'cohort'
            ? citation.label
            : citation.type === 'analysis'
              ? `${citation.label}: ${citation.statistic}`
              : citation.label
      }
    >
      {body}
    </button>
  );
}

function Popover({
  open,
  title,
  children,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <span className="cp__pop" role="tooltip">
      <span className="cp__popTitle mono">{title}</span>
      {children}
    </span>
  );
}
