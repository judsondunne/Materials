import { useMemo, useState } from 'react';
import { summariseTarget, isTargetSet } from '../analysis/target';
import { Empty, PageHead, TargetLine } from '../components/Bits';
import { Disclosure } from '../components/Disclosure';
import { Icon } from '../components/Icon';
import { formatValue, pluralize } from '../domain/format';
import { buildCategories } from '../domain/variables';
import type { Dataset, FieldId } from '../domain/types';
import { toggleSelection, type AppState } from '../state/appState';
import type { Route } from '../state/router';
import type { Update } from '../state/store';

interface Props {
  ds: Dataset;
  state: AppState;
  rows: number[];
  update: Update;
  navigate: (route: Route) => void;
}

type Sort = { field: FieldId | 'id' | 'match'; dir: 'asc' | 'desc' };

/**
 * Every run, in one table.
 *
 * The default columns are the five measured properties and the process setting —
 * the things a scientist scans for. The eighteen formulation columns are real but
 * they turn this into a spreadsheet, so they are behind a switch, and any
 * ingredient can be brought in one at a time.
 */
export function ExperimentsPage({ ds, state, rows, update, navigate }: Props) {
  const [sort, setSort] = useState<Sort>({ field: 'id', dir: 'asc' });
  const [extraCols, setExtraCols] = useState<FieldId[]>([]);
  const [onlyMatches, setOnlyMatches] = useState(false);

  const targeted = isTargetSet(state.target);
  const outcome = useMemo(() => summariseTarget(ds, state.target), [ds, state.target]);
  const matchByRow = useMemo(() => new Map(outcome.matches.map((m) => [m.row, m])), [outcome]);
  const cats = useMemo(() => buildCategories(ds), [ds]);

  const columns: FieldId[] = useMemo(
    () => [...ds.outputs, ...ds.process, ...extraCols],
    [ds.outputs, ds.process, extraCols],
  );

  const visible = useMemo(() => {
    const q = state.query.trim().toLowerCase();
    let list = rows.filter((r) => !q || (ds.experiments[r]?.id.toLowerCase().includes(q) ?? false));
    if (onlyMatches && targeted) list = list.filter((r) => matchByRow.get(r)?.satisfiesAll);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      if (sort.field === 'id') {
        return dir * (ds.experiments[a]?.id ?? '').localeCompare(ds.experiments[b]?.id ?? '');
      }
      if (sort.field === 'match') {
        const ma = matchByRow.get(a);
        const mb = matchByRow.get(b);
        return dir * ((ma?.distance ?? 9) - (mb?.distance ?? 9));
      }
      const col = ds.columns.get(sort.field);
      return dir * ((col?.[a] ?? 0) - (col?.[b] ?? 0));
    });
  }, [rows, state.query, onlyMatches, targeted, matchByRow, sort, ds]);

  const head = (field: Sort['field'], label: string, numeric = true) => (
    <th
      key={String(field)}
      className={numeric ? 'is-num' : ''}
      aria-sort={sort.field === field ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className="tbl__sort"
        onClick={() =>
          setSort((s) =>
            s.field === field ? { field, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'desc' },
          )
        }
      >
        {label}
        {sort.field === field && (
          <span className="tbl__dir" aria-hidden="true">
            {sort.dir === 'asc' ? '↑' : '↓'}
          </span>
        )}
      </button>
    </th>
  );

  return (
    <div className="page">
      <PageHead title="Experiments" purpose="Everything that has been run and measured.">
        {targeted && <TargetLine ds={ds} target={state.target} onEdit={() => navigate({ name: 'target' })} />}
      </PageHead>

      <div className="toolbar">
        <label className="search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={state.query}
            placeholder="Find an experiment id"
            onChange={(e) => update((s) => ({ ...s, query: e.target.value }))}
          />
          {state.query && (
            <button type="button" className="search__clear" onClick={() => update((s) => ({ ...s, query: '' }))} aria-label="Clear search">
              <Icon name="close" size={11} />
            </button>
          )}
        </label>

        {targeted && (
          <label className="check">
            <input type="checkbox" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} />
            Only experiments meeting the target
            <span className="check__count num">{outcome.feasible.length}</span>
          </label>
        )}

        <span className="toolbar__spacer" />

        <span className="toolbar__count num">
          {visible.length === rows.length
            ? `${rows.length} ${pluralize(rows.length, 'experiment')}`
            : `${visible.length} of ${rows.length}`}
        </span>

        {state.selection.length > 0 && (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={state.selection.length < 2}
            onClick={() => navigate({ name: 'compare' })}
          >
            Compare {state.selection.length === 2 ? 'the two selected' : '(pick one more)'}
          </button>
        )}
      </div>

      <Disclosure summary="Add formulation columns" count={extraCols.length || undefined}>
        <div className="colpick">
          {cats
            .filter((c) => c.id !== 'process')
            .map((cat) => (
              <div key={cat.id} className="colpick__cat">
                <span className="colpick__catName">{cat.label}</span>
                {cat.fields.map((f) => {
                  const on = extraCols.includes(f);
                  return (
                    <button
                      key={f}
                      type="button"
                      className={`chip ${on ? 'is-on' : ''}`}
                      aria-pressed={on}
                      onClick={() =>
                        setExtraCols((cols) => (on ? cols.filter((c) => c !== f) : [...cols, f]))
                      }
                    >
                      {ds.fields.get(f)?.short}
                    </button>
                  );
                })}
              </div>
            ))}
          {extraCols.length > 0 && (
            <button type="button" className="linkbtn" onClick={() => setExtraCols([])}>
              Remove all
            </button>
          )}
        </div>
      </Disclosure>

      {visible.length === 0 ? (
        <Empty
          icon="search"
          title="Nothing matches."
          body={
            onlyMatches
              ? 'No experiment satisfies the whole target. Turn the filter off to see the closest ones.'
              : 'No experiment id contains that text.'
          }
          action={
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                setOnlyMatches(false);
                update((s) => ({ ...s, query: '' }));
              }}
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th className="tbl__pickHead" aria-label="Select for comparison" />
                {head('id', 'Experiment', false)}
                {targeted && head('match', 'Target')}
                {columns.map((c) => head(c, ds.fields.get(c)?.short ?? c))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const exp = ds.experiments[r]!;
                const m = matchByRow.get(r);
                const picked = state.selection.includes(exp.id);
                return (
                  <tr key={exp.id} className={picked ? 'is-sel' : ''}>
                    <td className="tbl__pick">
                      <button
                        type="button"
                        className={`tickbox ${picked ? 'is-on' : ''}`}
                        aria-pressed={picked}
                        aria-label={`${picked ? 'Remove' : 'Add'} ${exp.id} ${picked ? 'from' : 'to'} comparison`}
                        onClick={() => update((s) => toggleSelection(s, exp.id))}
                      >
                        {picked && <Icon name="check" size={10} />}
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="tbl__id mono"
                        onClick={() => navigate({ name: 'experiment', id: exp.id })}
                      >
                        {exp.id}
                      </button>
                    </td>
                    {targeted && (
                      <td className="is-num">
                        {m && m.activeCount > 0 && (
                          <span className={`mini ${m.satisfiesAll ? 'is-met' : 'is-miss'}`}>
                            {m.satisfiesAll ? (
                              <>
                                <Icon name="check" size={10} /> all
                              </>
                            ) : (
                              `${m.satisfiedCount}/${m.activeCount}`
                            )}
                          </span>
                        )}
                      </td>
                    )}
                    {columns.map((c) => {
                      const meta = ds.fields.get(c)!;
                      const v = ds.columns.get(c)?.[r];
                      const evalr = m?.evaluations.find((e) => e.property === c);
                      return (
                        <td
                          key={c}
                          className={`is-num ${evalr ? (evalr.satisfied ? 'is-met' : 'is-miss') : ''} ${
                            v === 0 && ds.formulation.includes(c) ? 'is-zero' : ''
                          }`}
                        >
                          {v === undefined || !Number.isFinite(v)
                            ? '—'
                            : v === 0 && ds.formulation.includes(c)
                              ? '—'
                              : formatValue(v, meta.decimals)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
