import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from '../Icon';

export interface ChartCardProps {
  /** Stable key — also the value the page stores to know which card is open. */
  id: string;
  title: string;
  /** What the chart currently shows, in one sentence. Recomputed as it filters. */
  reading: string;
  /** A chip or coefficient, pinned to the right of the title. */
  badge?: ReactNode;
  /** Controls that belong to this chart. Always visible; they do not open it. */
  controls?: ReactNode;
  /** A legend or key, under the chart in both sizes. */
  legend?: ReactNode;
  /** Extra detail worth the room only when the card is full screen. */
  detail?: ReactNode;
  /** Columns this card occupies in the grid. */
  span?: 1 | 2 | 3;
  /** Chart height when tiled, and when expanded. */
  compactHeight?: number;
  expandedHeight?: number;
  expanded: boolean;
  onExpand: (id: string | null) => void;
  /** Rendered at the height the current size calls for. */
  children: (height: number, expanded: boolean) => ReactNode;
}

/**
 * One chart, in a card you can open.
 *
 * Nine charts at a readable size do not fit on a screen, and nine charts shrunk
 * until they do are decoration. So each one is tiled at a size that is honest
 * about being a summary — title, a sentence saying what it currently shows, and
 * enough chart to judge whether it is worth your attention — and opens to fill
 * the viewport when it is. The chart is the same component at both sizes, given
 * a different height, rather than a thumbnail standing in for a real chart.
 *
 * The expanded state is a modal in the accessibility sense: labelled by its own
 * title, focus moved into it, Escape and the backdrop both close it, and the
 * page behind it is frozen rather than left scrollable underneath.
 */
export function ChartCard({
  id,
  title,
  reading,
  badge,
  controls,
  legend,
  detail,
  span = 1,
  compactHeight = 208,
  expandedHeight = 560,
  expanded,
  onExpand,
  children,
}: ChartCardProps) {
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes, and the scroll position behind the overlay is held: a modal
  // that lets the page scroll under it loses the user's place in the grid.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onExpand(null);
      }
    };
    window.addEventListener('keydown', onKey);
    const prior = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prior;
    };
  }, [expanded, onExpand]);

  // Returning focus to the button that opened the card, rather than to the top
  // of the document, is the difference between a keyboard being usable here.
  useEffect(() => {
    if (!expanded) openerRef.current?.focus({ preventScroll: true });
    // Only on the transition out; focusing on mount would steal it on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const head = (
    <div className="cc__head">
      <div className="cc__titles">
        <h3 className="cc__title" id={headingId}>
          {title}
        </h3>
        <p className="cc__reading">{reading}</p>
      </div>
      {badge && <div className="cc__badge">{badge}</div>}
    </div>
  );

  if (expanded) {
    return (
      <>
        {/* The tile keeps its place in the grid so the layout does not jump. */}
        <article className={`cc cc--span${span} is-lifted`} aria-hidden="true">
          <div className="cc__ghost">
            <Icon name="chart" size={18} />
            <span>{title}</span>
          </div>
        </article>

        <div className="ccx" role="presentation">
          <button
            type="button"
            className="ccx__scrim"
            aria-label={`Close ${title}`}
            onClick={() => onExpand(null)}
          />
          <section className="ccx__panel" role="dialog" aria-modal="true" aria-labelledby={headingId}>
            <header className="ccx__head">
              {head}
              <button
                type="button"
                ref={closeRef}
                className="iconbtn ccx__close"
                onClick={() => onExpand(null)}
                aria-label="Close"
                title="Close (Esc)"
              >
                <Icon name="close" size={13} />
              </button>
            </header>
            {controls && <div className="cc__controls cc__controls--wide">{controls}</div>}
            <div className="ccx__body">{children(expandedHeight, true)}</div>
            {legend && <div className="cc__legend">{legend}</div>}
            {detail && <div className="ccx__detail">{detail}</div>}
          </section>
        </div>
      </>
    );
  }

  return (
    <article className={`cc cc--span${span}`} aria-labelledby={headingId}>
      {head}
      {controls && <div className="cc__controls">{controls}</div>}
      <div className="cc__body">{children(compactHeight, false)}</div>
      {legend && <div className="cc__legend">{legend}</div>}
      <button
        type="button"
        ref={openerRef}
        className="cc__open"
        onClick={() => onExpand(id)}
        aria-label={`Open ${title} full screen`}
        title="Open full screen"
      >
        <Icon name="columns" size={12} />
        <span>Expand</span>
      </button>
    </article>
  );
}
