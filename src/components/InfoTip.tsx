import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * Methodology, one click away and never in the way. Click rather than hover, so
 * it is reachable by keyboard and readable on a touch screen.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="tip">
      <button
        type="button"
        className={`tip__btn ${open ? 'is-open' : ''}`}
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setOpen(false);
        }}
      >
        <Icon name="info" size={13} />
      </button>
      {open && (
        <span className="tip__pop" id={id} role="note">
          <span className="tip__title">{label}</span>
          {children}
          <button type="button" className="tip__close" onClick={() => setOpen(false)} aria-label="Close">
            <Icon name="close" size={11} />
          </button>
        </span>
      )}
    </span>
  );
}
