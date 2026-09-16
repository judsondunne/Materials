import { memo, useState } from 'react';
import { describeConstraint, type TargetProfile } from '../analysis/target';
import { formatValue } from '../domain/format';
import type { Dataset } from '../domain/types';
import { NAV, sectionOf, type Route } from '../state/router';
import { Icon, type IconName } from './Icon';

interface Props {
  ds: Dataset;
  route: Route;
  target: TargetProfile;
  selectionCount: number;
  navigate: (route: Route) => void;
}

/**
 * Six destinations and the current specification.
 *
 * The target lives here rather than on a page because it is the thing that makes
 * the app one investigation: it has to be visible, and editable, from wherever
 * the user has wandered to.
 */
export const Sidebar = memo(function Sidebar({ ds, route, target, selectionCount, navigate }: Props) {
  const here = sectionOf(route);
  const [targetOpen, setTargetOpen] = useState(true);
  const constraints = Object.values(target);

  return (
    <nav className="side" aria-label="Main">
      {/*
        The mark is the composition bar this application draws everywhere else —
        a compound as parts of a whole — rather than a laboratory flask, which
        says "science" and nothing about what is on screen. The name says what
        the tool does rather than who made it.
      */}
      <button type="button" className="side__brand" onClick={() => navigate({ name: 'target' })}>
        <span className="side__mark" aria-hidden="true">
          <span className="side__markBar" />
          <span className="side__markBar" />
          <span className="side__markBar" />
        </span>
        <span className="side__name">Compound Design</span>
      </button>

      <ul className="side__nav">
        {NAV.map((item) => (
          <li key={item.name}>
            <button
              type="button"
              className={`side__link ${here === item.name ? 'is-on' : ''}`}
              aria-current={here === item.name ? 'page' : undefined}
              onClick={() => navigate({ name: item.name } as Route)}
            >
              <Icon name={item.icon as IconName} size={17} />
              <span>{item.label}</span>
              {item.name === 'experiments' && selectionCount > 0 && (
                <span className="side__badge num">{selectionCount}</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <div className="side__target">
        {/* A chevron that rotates, not a word that changes. The target is the
            one piece of state that follows you across every screen, so it stays
            reachable — but it does not have to stay open. */}
        <button
          type="button"
          className="side__targetHead"
          aria-expanded={targetOpen}
          onClick={() => setTargetOpen((v) => !v)}
        >
          <span className={`side__chev ${targetOpen ? 'is-open' : ''}`} aria-hidden="true">
            <Icon name="chevronDown" size={12} />
          </span>
          <span>Target</span>
          <span className="side__targetCount num">{constraints.length || ''}</span>
        </button>
        {!targetOpen ? null : constraints.length === 0 ? (
          <p className="side__targetNone">
            Nothing specified yet.{' '}
            <button type="button" className="linkbtn" onClick={() => navigate({ name: 'target' })}>
              set one
            </button>
          </p>
        ) : (
          <ul className="side__targetList">
            {constraints.map((c) => {
              const meta = ds.fields.get(c.property);
              return (
                <li key={c.property}>
                  <span className="side__targetProp">{meta?.short ?? c.property}</span>
                  <span className="side__targetOp num">
                    {describeConstraint(c, (v) => formatValue(v, meta?.decimals ?? 1))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {targetOpen && constraints.length > 0 && (
          <button
            type="button"
            className="side__targetEdit"
            onClick={() => navigate({ name: 'target' })}
          >
            Edit the specification
          </button>
        )}
      </div>
    </nav>
  );
});
