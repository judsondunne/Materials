import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * The app's one mechanism for depth.
 *
 * Default: the answer. Behind one click: why. Behind another: the arithmetic.
 * Everything that would otherwise crowd a screen goes in one of these, so a
 * page can carry a lot of analysis and still open quietly.
 */
export function Disclosure({
  summary,
  children,
  tone = 'plain',
  defaultOpen = false,
  count,
}: {
  summary: string;
  children: ReactNode;
  tone?: 'plain' | 'method';
  defaultOpen?: boolean;
  count?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={`disc disc--${tone} ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="disc__btn"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="disc__chev">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </span>
        {tone === 'method' && <Icon name="info" size={12} />}
        <span className="disc__label">{summary}</span>
        {count !== undefined && <span className="disc__count num">{count}</span>}
      </button>
      {open && (
        <div className="disc__body" id={id}>
          {children}
        </div>
      )}
    </div>
  );
}
