import type { ReactNode } from 'react';
import { SUPPORT_CAVEAT, SUPPORT_COPY, type HistoricalSupport } from '../analysis/estimate';
import { describeConstraint, type TargetProfile } from '../analysis/target';
import { formatValue } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import { Icon, type IconName } from './Icon';
import { InfoTip } from './InfoTip';

export function PageHead({
  title,
  purpose,
  children,
}: {
  title: string;
  purpose: string;
  children?: ReactNode;
}) {
  return (
    <header className="ph">
      <div className="ph__text">
        <h1 className="ph__title">{title}</h1>
        <p className="ph__purpose">{purpose}</p>
      </div>
      {children && <div className="ph__actions">{children}</div>}
    </header>
  );
}

export function Section({
  title,
  note,
  children,
  aside,
}: {
  title: string;
  note?: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="sec">
      <div className="sec__head">
        <h2 className="sec__title">{title}</h2>
        {note && <span className="sec__note">{note}</span>}
        {aside && <div className="sec__aside">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} size={20} />
      </span>
      <p className="empty__title">{title}</p>
      <p className="empty__body">{body}</p>
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

/** The active specification, in one line, everywhere it needs to be visible. */
export function TargetLine({
  ds,
  target,
  onEdit,
}: {
  ds: Dataset;
  target: TargetProfile;
  onEdit?: () => void;
}) {
  const items = Object.values(target);
  if (items.length === 0) {
    return (
      <div className="tl tl--none">
        <span className="tl__label">No target set</span>
        {onEdit && (
          <button type="button" className="linkbtn" onClick={onEdit}>
            Define one
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="tl">
      <span className="tl__label">Target</span>
      <span className="tl__items">
        {items.map((c) => {
          const meta = ds.fields.get(c.property);
          return (
            <span key={c.property} className="tl__item">
              <span className="tl__prop">{meta?.short ?? c.property}</span>
              <span className="tl__op num">
                {describeConstraint(c, (v) => formatValue(v, meta?.decimals ?? 1))}
              </span>
            </span>
          );
        })}
      </span>
      {onEdit && (
        <button type="button" className="linkbtn tl__edit" onClick={onEdit}>
          Edit
        </button>
      )}
    </div>
  );
}

export function SupportBadge({
  support,
  compact = false,
}: {
  support: HistoricalSupport;
  compact?: boolean;
}) {
  const copy = SUPPORT_COPY[support.level];
  return (
    <span className={`sup sup--${support.level} ${compact ? 'sup--compact' : ''}`}>
      <Icon name={support.level === 'high' ? 'check' : support.level === 'moderate' ? 'info' : 'warn'} size={12} />
      <span className="sup__label">{copy.label}</span>
      {!compact && (
        <InfoTip label="How historical support is judged">
          <p>{copy.detail}</p>
          <ul className="tip__list">
            <li>
              Nearest experiment: <span className="num">{support.nearestDistance.toFixed(3)}</span> in
              normalised input space
            </li>
            <li>
              This study's own typical experiment-to-experiment distance:{' '}
              <span className="num">{support.bandwidth.toFixed(3)}</span>
            </li>
            <li>
              Experiments effectively contributing:{' '}
              <span className="num">{support.effectiveN.toFixed(1)}</span> of 5 weighted
            </li>
          </ul>
          <p className="tip__foot">{SUPPORT_CAVEAT}</p>
        </InfoTip>
      )}
    </span>
  );
}

/** The value meaning "no field chosen". Kept here so no caller invents its own. */
export const NO_FIELD = '__none';

export function FieldSelect({
  id,
  label,
  value,
  options,
  ds,
  onChange,
  groups,
  noneLabel = 'none',
}: {
  id: string;
  label: string;
  value: FieldId;
  options: readonly FieldId[];
  ds: Dataset;
  onChange: (id: FieldId) => void;
  /** Optional grouping label per field, for an <optgroup> per shelf. */
  groups?: Map<FieldId, string>;
  /** What the empty choice reads as, when `options` includes `NO_FIELD`. */
  noneLabel?: string;
}) {
  const name = (o: FieldId) => (o === NO_FIELD ? noneLabel : (ds.fields.get(o)?.label ?? o));
  const real = options.filter((o) => o !== NO_FIELD);
  const hasNone = options.length !== real.length;
  const grouped = groups
    ? [...new Set(real.map((o) => groups.get(o) ?? 'Other'))].map((g) => ({
        label: g,
        items: real.filter((o) => (groups.get(o) ?? 'Other') === g),
      }))
    : null;
  return (
    <label className="fs" htmlFor={id}>
      <span className="fs__label">{label}</span>
      <select
        id={id}
        className="fs__select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {hasNone && <option value={NO_FIELD}>{noneLabel}</option>}
        {grouped
          ? grouped.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map((o) => (
                  <option key={o} value={o}>
                    {name(o)}
                  </option>
                ))}
              </optgroup>
            ))
          : real.map((o) => (
              <option key={o} value={o}>
                {name(o)}
              </option>
            ))}
      </select>
      <span className="fs__chev" aria-hidden="true">
        <Icon name="chevronDown" size={11} />
      </span>
    </label>
  );
}

/** A measured number and an estimated number must never look the same. */
export function Value({
  v,
  decimals,
  estimated = false,
  size = 'md',
}: {
  v: number;
  decimals: number;
  estimated?: boolean;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span className={`val val--${size} ${estimated ? 'val--est' : ''} num`}>
      {estimated && <span className="val__tilde">~</span>}
      {formatValue(v, decimals)}
    </span>
  );
}

export function Note({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'warn' }) {
  return <p className={`note note--${tone}`}>{children}</p>;
}
