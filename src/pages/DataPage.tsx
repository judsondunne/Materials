import { useMemo, useState } from 'react';
import { compareCohort, phraseComparison } from '../analysis/cohort';
import { applyFilters, normaliseFilter, rowsInBand, type RangeFilter } from '../analysis/filters';
import * as read from '../analysis/readings';
import {
  RELATIONSHIP_CAVEAT,
  phraseRelationship,
  rankAgainst,
  relationship,
  strengthLabel,
} from '../analysis/relationships';
import { describe, paretoFront } from '../analysis/stats';
import { summariseTarget } from '../analysis/target';
import { Bars, type BarItem } from '../charts/Bars';
import { BoxPlot } from '../charts/BoxPlot';
import { Composition } from '../charts/Composition';
import { Heatmap, type HeatCell } from '../charts/Heatmap';
import { Histogram } from '../charts/Histogram';
import { Parallel } from '../charts/Parallel';
import { Scatter } from '../charts/Scatter';
import { Timeline } from '../charts/Timeline';
import { TradeOff, type Direction } from '../charts/TradeOff';
import { Empty, FieldSelect, NO_FIELD, PageHead } from '../components/Bits';
import { ChartCard } from '../components/data/ChartCard';
import { InputHistograms } from '../components/data/InputHistograms';
import { ScopeBar } from '../components/data/ScopeBar';
import { DistStrip } from '../components/DistStrip';
import { Icon } from '../components/Icon';
import { formatValue, pluralize } from '../domain/format';
import type { Dataset, FieldId } from '../domain/types';
import { buildCategories, categoryColor, categoryLabel } from '../domain/variables';
import type { AppState, DataState } from '../state/appState';
import type { Route } from '../state/router';
import type { Update } from '../state/store';

interface Props {
  ds: Dataset;
  state: AppState;
  rows: number[];
  update: Update;
  navigate: (route: Route) => void;
}

/**
 * The Data workspace.
 *
 * One set of rows, ten ways of looking at it, and a single bar at the top that
 * decides both. Everything below the scope bar is a card: a title, a sentence
 * saying what that chart currently shows, enough chart to judge whether the
 * sentence is worth checking, and a full-screen view one click away. The cards
 * are not independent widgets — they all read `visible` and `focus`, so picking
 * a property or dragging a filter moves the whole page at once. That is the
 * difference between a dashboard and ten charts sharing a URL.
 *
 * The charts themselves know nothing about this page: each one takes rows, a
 * field or two, and a height. Everything about *which* rows and *why* is
 * decided here, and everything about how a mark is drawn is decided there.
 */
export function DataPage({ ds, state, rows, update, navigate }: Props) {
  const { data } = state;
  const [open, setOpen] = useState<string | null>(null);

  const setData = (patch: Partial<DataState>) =>
    update((s) => ({ ...s, data: { ...s.data, ...patch } }));

  // ── The rows every chart draws ──────────────────────────────────────────
  const visible = useMemo(
    () => applyFilters(ds, rows, data.filters, state.query),
    [ds, rows, data.filters, state.query],
  );
  const inBand = useMemo(
    () => rowsInBand(ds, visible, data.focus, data.band),
    [ds, visible, data.focus, data.band],
  );
  const bandActive = data.band !== null;
  const bandSet = useMemo(() => (bandActive ? new Set(inBand) : undefined), [bandActive, inBand]);
  const outOfBand = useMemo(
    () => (bandSet ? visible.filter((r) => !bandSet.has(r)) : []),
    [visible, bandSet],
  );

  // ── Marks the whole app shares ──────────────────────────────────────────
  const outcome = useMemo(() => summariseTarget(ds, state.target), [ds, state.target]);
  const cohort = useMemo(() => new Set(outcome.feasible.map((m) => m.row)), [outcome]);
  const selected = useMemo(() => rowSet(ds, state.selection), [ds, state.selection]);
  const highlighted = useMemo(
    () => rowSet(ds, state.highlight?.ids ?? []),
    [ds, state.highlight],
  );
  const brushed = useMemo(
    () => [...rowSet(ds, state.brushed)],
    [ds, state.brushed],
  );
  const setBrushed = (picked: number[]) =>
    update((s) => ({
      ...s,
      brushed: picked.map((r) => ds.experiments[r]?.id ?? '').filter(Boolean),
    }));

  // ── Per-card analysis ───────────────────────────────────────────────────
  const rel = useMemo(
    () => relationship(ds, data.x, data.y, visible),
    [ds, data.x, data.y, visible],
  );
  const ranked = useMemo(
    () => rankAgainst(ds, data.focus, visible, 'inputs'),
    [ds, data.focus, visible],
  );
  const comparison = useMemo(
    () =>
      bandSet && inBand.length > 0 && outOfBand.length > 0
        ? compareCohort(ds, inBand, outOfBand)
        : compareCohort(ds, visible, []),
    [ds, bandSet, inBand, outOfBand, visible],
  );
  const focusSummary = useMemo(() => {
    const col = ds.columns.get(data.focus);
    return col ? describe(col, visible) : null;
  }, [ds, data.focus, visible]);

  const matrix = useMemo(() => buildMatrix(ds, visible), [ds, visible]);
  const spread = useMemo(() => widestProperty(ds, visible), [ds, visible]);
  const tradeDirs = useMemo(
    () => ({
      a: directionOf(state, data.against),
      b: directionOf(state, data.focus),
    }),
    [state, data.against, data.focus],
  );
  const front = useMemo(() => {
    const ac = ds.columns.get(data.against);
    const bc = ds.columns.get(data.focus);
    if (!ac || !bc) return new Set<number>();
    const pts = visible
      .map((r) => ({ row: r, a: ac[r] ?? NaN, b: bc[r] ?? NaN }))
      .filter((p) => Number.isFinite(p.a) && Number.isFinite(p.b));
    return paretoFront(pts, tradeDirs.a, tradeDirs.b);
  }, [ds, visible, data.against, data.focus, tradeDirs]);
  const tradeRel = useMemo(
    () => relationship(ds, data.against, data.focus, visible),
    [ds, data.against, data.focus, visible],
  );
  const drift = useMemo(() => dateDrift(ds, visible, data.focus), [ds, visible, data.focus]);
  const parallelAxes = useMemo(() => {
    const drivers = ranked.filter((r) => r.role === 'input').slice(0, 4).map((r) => r.x);
    return [...new Set([...drivers, data.focus])];
  }, [ranked, data.focus]);
  const ingredientUse = useMemo(() => {
    let used = 0;
    for (const f of ds.formulation) {
      const col = ds.columns.get(f);
      if (col && visible.some((r) => (col[r] ?? 0) > 0)) used++;
    }
    return { used, total: ds.formulation.length };
  }, [ds, visible]);

  // ── Field pickers ───────────────────────────────────────────────────────
  const everything = useMemo(
    () => [...ds.outputs, ...ds.formulation, ...ds.process],
    [ds],
  );
  const fieldGroups = useMemo(() => {
    const m = new Map<FieldId, string>();
    for (const c of buildCategories(ds)) for (const f of c.fields) m.set(f, c.label);
    for (const o of ds.outputs) m.set(o, 'Measured properties');
    return m;
  }, [ds]);

  const focusMeta = ds.fields.get(data.focus)!;
  const openExperiment = (row: number) => {
    const id = ds.experiments[row]?.id;
    if (id) navigate({ name: 'experiment', id });
  };
  /** Clicking an input anywhere on the page plots it against the focused property. */
  const plotAgainstFocus = (field: FieldId) =>
    setData({ x: field, y: data.focus, colorBy: data.colorBy });

  const card = (id: string) => ({ id, expanded: open === id, onExpand: setOpen });

  if (visible.length === 0) {
    return (
      <div className="page page--wide dw">
        <PageHead title="Data" purpose={PURPOSE} />
        <ScopeBar
          ds={ds}
          total={rows.length}
          visible={visible}
          query={state.query}
          onQuery={(query) => update((s) => ({ ...s, query }))}
          filters={data.filters}
          onFilters={(filters) => setData({ filters: clean(ds, filters) })}
          focus={data.focus}
          onFocus={(focus) => setData({ focus, band: null, y: focus })}
          band={data.band}
          onBand={(band) => setData({ band })}
          inBand={inBand.length}
        />
        <Empty
          icon="search"
          title="Nothing matches those filters."
          body="Widen a range or clear the search to bring the experiments back."
          action={
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                setData({ filters: [] });
                update((s) => ({ ...s, query: '' }));
              }}
            >
              Clear filters
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="page page--wide dw">
      <PageHead title="Data" purpose={PURPOSE} />

      <ScopeBar
        ds={ds}
        total={rows.length}
        visible={visible}
        query={state.query}
        onQuery={(query) => update((s) => ({ ...s, query }))}
        filters={data.filters}
        onFilters={(filters) => setData({ filters: clean(ds, filters) })}
        focus={data.focus}
        onFocus={(focus) =>
          setData({
            focus,
            band: null,
            y: focus,
            against: data.against === focus ? (ds.outputs.find((o) => o !== focus) ?? focus) : data.against,
          })
        }
        band={data.band}
        onBand={(band) => setData({ band })}
        inBand={inBand.length}
      />

      <div className="dw__grid">
        {/* ── 1. The free-form scatter ──────────────────────────────────── */}
        <ChartCard
          {...card('relationship')}
          title="Relationship"
          reading={read.readRelationship(ds, rel)}
          span={2}
          compactHeight={272}
          expandedHeight={560}
          badge={
            rel?.r != null && (
              <span className={`rchip ${rel.clearsNoise ? 'is-real' : 'is-noise'}`} title={`Pearson r over ${rel.n} experiments · noise floor ${rel.floor.toFixed(2)}`}>
                <span className="rchip__val num">
                  {rel.r >= 0 ? '+' : '−'}
                  {Math.abs(rel.r).toFixed(2)}
                </span>
                <span className="rchip__label">{strengthLabel(rel)}</span>
              </span>
            )
          }
          controls={
            <>
              <FieldSelect
                id="dw-y"
                label=""
                value={data.y}
                options={everything}
                ds={ds}
                groups={fieldGroups}
                onChange={(y) => setData({ y, focus: ds.outputs.includes(y) ? y : data.focus })}
              />
              <span className="dw__vs">against</span>
              <FieldSelect
                id="dw-x"
                label=""
                value={data.x}
                options={everything}
                ds={ds}
                groups={fieldGroups}
                onChange={(x) => setData({ x })}
              />
              <button
                type="button"
                className="iconbtn"
                onClick={() => setData({ x: data.y, y: data.x })}
                title="Swap the axes"
                aria-label="Swap the axes"
              >
                <Icon name="reset" size={12} />
              </button>
              <span className="dw__ctrlSpacer" />
              <FieldSelect
                id="dw-col"
                label="colour"
                value={data.colorBy ?? NO_FIELD}
                options={[NO_FIELD, ...everything]}
                ds={ds}
                groups={fieldGroups}
                noneLabel="none"
                onChange={(c) => setData({ colorBy: c === NO_FIELD ? null : c })}
              />
            </>
          }
          legend={
            <>
              {cohort.size > 0 && <span className="lg lg--cohort">meets the target ({cohort.size})</span>}
              {selected.size > 0 && <span className="lg lg--sel">selected for comparison</span>}
              {bandActive && (
                <span className="lg lg--band">
                  in the {focusMeta.short} range ({inBand.length} of {visible.length})
                </span>
              )}
              {state.highlight && (
                <span className="lg lg--ai">
                  {state.highlight.ids.length} highlighted
                  <button
                    type="button"
                    className="lg__clear"
                    onClick={() => update((s) => ({ ...s, highlight: null }))}
                    aria-label="Clear the highlight"
                  >
                    <Icon name="close" size={9} />
                  </button>
                </span>
              )}
              {rel?.clearsNoise && <span className="lg lg--trend">least-squares line</span>}
              <span className="dw__ctrlSpacer" />
              {brushed.length > 0 ? (
                <span className="lg lg--brush">
                  <strong className="num">{brushed.length}</strong>{' '}
                  {pluralize(brushed.length, 'experiment')} selected
                  <button type="button" className="lg__clear" onClick={() => setBrushed([])} aria-label="Clear">
                    <Icon name="close" size={9} />
                  </button>
                </span>
              ) : (
                <span className="lg lg--hint">drag a box to select · click a point to open it</span>
              )}
            </>
          }
          detail={
            rel && (
              <>
                <p className="dw__prose">
                  {phraseRelationship(rel, ds.fields.get(data.x)?.short ?? data.x, ds.fields.get(data.y)?.short ?? data.y)}
                </p>
                <p className="dw__caveat">{RELATIONSHIP_CAVEAT}</p>
              </>
            )
          }
        >
          {(h) => (
            <Scatter
              ds={ds}
              x={data.x}
              y={data.y}
              rows={visible}
              colorBy={data.colorBy}
              sizeBy={data.sizeBy}
              trend={rel?.clearsNoise ?? false}
              marks={{ cohort, selected, band: bandSet, highlighted }}
              onPick={openExperiment}
              onBrush={setBrushed}
              height={h}
            />
          )}
        </ChartCard>

        {/* ── 2. What moves with the focused property ───────────────────── */}
        <ChartCard
          {...card('drivers')}
          title={`What moves with ${focusMeta.short}`}
          reading={read.readDrivers(ds, data.focus, ranked)}
          compactHeight={272}
          expandedHeight={Math.max(320, ranked.length * 24 + 50)}
          badge={
            <span className="minichip">
              {ranked.filter((r) => r.clearsNoise).length} clear the floor
            </span>
          }
          legend={
            <>
              <span className="lg lg--pos">rose together</span>
              <span className="lg lg--neg">moved opposite</span>
              <span className="lg lg--floor">noise floor for {ranked[0]?.n ?? visible.length} runs</span>
              <span className="dw__ctrlSpacer" />
              <span className="lg lg--hint">click a bar to plot it</span>
            </>
          }
          detail={<p className="dw__caveat">{RELATIONSHIP_CAVEAT}</p>}
        >
          {(h, expanded) => (
            <Bars
              items={ranked.map(driverBar)}
              limit={expanded ? undefined : 9}
              height={expanded ? undefined : h}
              threshold={ranked[0]?.floor ?? null}
              format={(v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`}
              xLabel={expanded ? `Pearson r against ${focusMeta.short}` : undefined}
              onPick={plotAgainstFocus}
            />
          )}
        </ChartCard>

        {/* ── 3. The assignment's histogram question ────────────────────── */}
        <ChartCard
          {...card('inputs')}
          title={bandActive ? `What went into that ${focusMeta.short} range` : `What went into every ${focusMeta.short}`}
          reading={read.readBand(ds, data.focus, data.band, inBand.length, visible.length, comparison.notable)}
          span={2}
          compactHeight={300}
          expandedHeight={640}
          badge={
            bandActive ? (
              <span className={`minichip ${inBand.length === 0 ? 'is-warn' : 'is-on'}`}>
                {inBand.length} of {visible.length} in range
              </span>
            ) : (
              <span className="minichip">{visible.length} runs</span>
            )
          }
          legend={
            <>
              <span className="lg lg--all">every run in view</span>
              <span className="lg lg--band">{bandActive ? 'in the chosen range' : 'no range chosen'}</span>
              <span className="dw__ctrlSpacer" />
              <span className="lg lg--hint">
                {comparison.reliability === 'anecdotal'
                  ? 'fewer than five runs in range — read these as anecdotes'
                  : 'click an input to plot it'}
              </span>
            </>
          }
          detail={
            comparison.notable.length === 0 ? (
              <p className="dw__prose">
                No input in the formulation or the process separates the runs in range from the rest.
              </p>
            ) : (
              <ul className="cmp">
                {comparison.notable.slice(0, 8).map((c) => (
                  <li key={c.field} className="cmp__row">
                    <span
                      className="cmp__cat"
                      style={{ background: `var(${categoryColor(c.category)})` }}
                      title={categoryLabel(c.category)}
                    />
                    <span className="cmp__name">{c.label}</span>
                    <span className="cmp__strip">
                      <DistStrip
                        ds={ds}
                        field={c.field}
                        rows={visible}
                        marks={inBand.map((r) => ds.columns.get(c.field)?.[r] ?? NaN)}
                        height={22}
                        bins={18}
                      />
                    </span>
                    <span className="cmp__phrase">{phraseComparison(c, formatValue)}</span>
                  </li>
                ))}
              </ul>
            )
          }
        >
          {(_h, expanded) => (
            <InputHistograms
              ds={ds}
              rows={visible}
              inBand={bandActive ? inBand : []}
              ranked={comparison.inputs}
              focus={data.focus}
              focusBand={data.band}
              limit={expanded ? comparison.inputs.length : 6}
              cellHeight={expanded ? 78 : 56}
              bare={!expanded}
              onPick={plotAgainstFocus}
            />
          )}
        </ChartCard>

        {/* ── 4. One property's shape ───────────────────────────────────── */}
        <ChartCard
          {...card('distribution')}
          title={`${focusMeta.short} distribution`}
          reading={focusSummary ? read.readDistribution(ds, data.focus, focusSummary) : 'Nothing to summarise.'}
          compactHeight={218}
          expandedHeight={460}
          badge={
            focusSummary && (
              <span className="minichip">
                median {formatValue(focusSummary.median, focusMeta.decimals)}
              </span>
            )
          }
          legend={
            <>
              <span className="lg lg--all">every run in view</span>
              {bandActive && <span className="lg lg--band">in the chosen range</span>}
            </>
          }
          detail={
            focusSummary && (
              <dl className="stats">
                {statRows(focusSummary, focusMeta.decimals).map((r) => (
                  <div key={r.k} className="stats__row">
                    <dt>{r.k}</dt>
                    <dd className="num">{r.v}</dd>
                  </div>
                ))}
              </dl>
            )
          }
        >
          {(h) => (
            <Histogram
              ds={ds}
              field={data.focus}
              rows={visible}
              subset={bandActive ? inBand : null}
              region={data.band}
              height={h}
            />
          )}
        </ChartCard>

        {/* ── 5. Every input against every property ─────────────────────── */}
        <ChartCard
          {...card('matrix')}
          title="Correlation matrix"
          reading={read.readMatrix(matrix.flat, matrix.flat.length)}
          span={2}
          compactHeight={300}
          expandedHeight={Math.max(420, matrix.rowFields.length * 26 + 80)}
          badge={<span className="minichip">{matrix.rowFields.length} inputs × {ds.outputs.length} properties</span>}
          legend={
            <>
              <span className="lg lg--pos">rose together</span>
              <span className="lg lg--neg">moved opposite</span>
              <span className="lg lg--ring">clears the noise floor</span>
              <span className="dw__ctrlSpacer" />
              <span className="lg lg--hint">click a cell to plot that pair</span>
            </>
          }
        >
          {(h, expanded) => {
            const take = expanded ? matrix.rowFields.length : 8;
            return (
              <Heatmap
                rowLabels={matrix.rowLabels.slice(0, take)}
                colLabels={matrix.colLabels}
                cells={matrix.cells.slice(0, take)}
                height={expanded ? undefined : h}
                labels={expanded}
                format={(v) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(2)}`}
                onPick={(i, j) =>
                  setData({
                    x: matrix.rowFields[i]!,
                    y: ds.outputs[j]!,
                    focus: ds.outputs[j]!,
                  })
                }
              />
            );
          }}
        </ChartCard>

        {/* ── 6. Every measured property's spread ───────────────────────── */}
        <ChartCard
          {...card('spread')}
          title="Property spread"
          reading={read.readSpread(ds, spread)}
          compactHeight={218}
          expandedHeight={380}
          badge={<span className="minichip">{ds.outputs.length} properties</span>}
          legend={
            <>
              <span className="lg lg--box">middle half</span>
              <span className="lg lg--median">median</span>
              {bandActive && <span className="lg lg--tri">median in range</span>}
              <span className="dw__ctrlSpacer" />
              <span className="lg lg--hint">each row on its own scale</span>
            </>
          }
          detail={
            <p className="dw__caveat">
              Rows are scaled to their own observed range so five different units can share one
              axis. Position means "where in this property's range", never "how large".
            </p>
          }
        >
          {(h) => (
            <BoxPlot
              ds={ds}
              fields={ds.outputs}
              rows={visible}
              subset={bandActive ? inBand : null}
              emphasis={data.focus}
              height={h}
              onPick={(focus) => setData({ focus, band: null, y: focus })}
            />
          )}
        </ChartCard>

        {/* ── 7. Whole formulations as lines ────────────────────────────── */}
        <ChartCard
          {...card('parallel')}
          title="Formulation paths"
          reading={read.readParallel(visible.length, parallelAxes.length)}
          span={2}
          compactHeight={244}
          expandedHeight={520}
          badge={<span className="minichip">{parallelAxes.length} axes</span>}
          legend={
            <>
              <span className="lg lg--grad">
                low {focusMeta.short} → high {focusMeta.short}
              </span>
              <span className="dw__ctrlSpacer" />
              <span className="lg lg--hint">hover a line to follow one run · click to open it</span>
            </>
          }
          detail={
            <p className="dw__caveat">
              Axes are the inputs most associated with {focusMeta.short}, ordered by strength, with
              the property itself last. Each axis spans only what the runs in view actually reached.
            </p>
          }
        >
          {(h) => (
            <Parallel
              ds={ds}
              axes={parallelAxes}
              rows={visible}
              colorBy={data.focus}
              subset={bandActive ? inBand : null}
              height={h}
              onPick={openExperiment}
            />
          )}
        </ChartCard>

        {/* ── 8. Two properties against each other ──────────────────────── */}
        <ChartCard
          {...card('tradeoff')}
          title="Trade-off frontier"
          reading={read.readTradeoff(ds, tradeRel, front.size)}
          compactHeight={244}
          expandedHeight={520}
          badge={<span className="minichip is-on">{front.size} on the frontier</span>}
          controls={
            <>
              <FieldSelect
                id="dw-against"
                label="against"
                value={data.against}
                options={ds.outputs.filter((o) => o !== data.focus)}
                ds={ds}
                onChange={(against) => setData({ against })}
              />
              <span className="dw__ctrlSpacer" />
              <span className="dw__ctrlNote">
                {focusMeta.short} {tradeDirs.b === 'max' ? 'high' : 'low'} ·{' '}
                {ds.fields.get(data.against)?.short} {tradeDirs.a === 'max' ? 'high' : 'low'}
              </span>
            </>
          }
          legend={
            <>
              <span className="lg lg--front">not beaten on both</span>
              <span className="lg lg--dominated">dominated</span>
              <span className="dw__ctrlSpacer" />
              <span className="lg lg--hint">direction follows your target where one is set</span>
            </>
          }
        >
          {(h) => (
            <TradeOff
              ds={ds}
              a={data.against}
              b={data.focus}
              dirA={tradeDirs.a}
              dirB={tradeDirs.b}
              rows={visible}
              selected={selected}
              cohort={cohort}
              height={h}
              onPick={openExperiment}
            />
          )}
        </ChartCard>

        {/* ── 9. Every recipe, stacked ──────────────────────────────────── */}
        <ChartCard
          {...card('composition')}
          title="Composition by run"
          reading={read.readComposition(ingredientUse.used, ingredientUse.total)}
          compactHeight={244}
          expandedHeight={Math.max(360, visible.length * 17 + 40)}
          badge={<span className="minichip">ordered by {focusMeta.short}</span>}
          legend={
            <>
              {buildCategories(ds)
                .filter((c) => c.id !== 'process')
                .map((c) => (
                  <span key={c.id} className="lg lg--swatch">
                    <span className="lg__sw" style={{ background: `var(${c.colorVar})` }} />
                    {c.label}
                  </span>
                ))}
            </>
          }
          detail={
            <p className="dw__caveat">
              Bars are sorted by {focusMeta.short}, highest first, and segments are summed per
              shelf. Bar length is the total loading, so a short bar is a leaner recipe.
            </p>
          }
        >
          {(h, expanded) => (
            <Composition
              ds={ds}
              rows={visible}
              orderBy={data.focus}
              subset={bandActive ? inBand : null}
              height={expanded ? undefined : h}
              labels={expanded}
              onPick={openExperiment}
            />
          )}
        </ChartCard>

        {/* ── 10. The campaign over time ────────────────────────────────── */}
        <ChartCard
          {...card('timeline')}
          title="Run history"
          reading={read.readTimeline(ds, data.focus, drift.r, drift.n)}
          span={2}
          compactHeight={218}
          expandedHeight={440}
          badge={<span className="minichip">{drift.n} dated runs</span>}
          legend={
            <>
              <span className="lg lg--all">every run in view</span>
              {bandActive && <span className="lg lg--band">in the chosen range</span>}
              <span className="dw__ctrlSpacer" />
              <span className="lg lg--hint">click a point to open the run</span>
            </>
          }
          detail={
            <p className="dw__caveat">
              These runs were a campaign, not a random sample. A property that climbs run after run
              may be telling you about the programme rather than about the formulation.
            </p>
          }
        >
          {(h) => (
            <Timeline
              ds={ds}
              rows={visible}
              field={data.focus}
              subset={bandActive ? inBand : null}
              selected={selected}
              height={h}
              onPick={openExperiment}
            />
          )}
        </ChartCard>
      </div>

      <p className="sr-only">
        {visible.length} of {rows.length} experiments are shown, keyed to {focusMeta.label}
        {bandActive
          ? `, narrowed to ${formatValue(data.band![0], focusMeta.decimals)} – ${formatValue(data.band![1], focusMeta.decimals)}`
          : ' over its whole observed range'}
        .
      </p>
    </div>
  );
}

const PURPOSE =
  'Every measurement in this study, as charts you can interrogate. Narrow the experiments once, pick the property in question, and open any card for the full view.';

const rowSet = (ds: Dataset, ids: readonly string[]) =>
  new Set(
    ids
      .map((id) => ds.experiments.find((e) => e.id === id)?.index)
      .filter((i): i is number => i !== undefined),
  );

/** Drops filters the user has widened back to the field's full range. */
const clean = (ds: Dataset, filters: readonly RangeFilter[]) =>
  filters
    .map((f) => normaliseFilter(ds, f))
    .filter((f): f is RangeFilter => f !== null);

function driverBar(r: ReturnType<typeof rankAgainst>[number]): BarItem {
  return {
    key: r.x,
    label: r.label,
    value: r.r ?? 0,
    colorVar: r.clearsNoise ? categoryColor(r.category) : undefined,
    faint: !r.clearsNoise,
    detail: [
      { k: 'Pearson r', v: (r.r ?? 0).toFixed(3) },
      { k: 'Spearman ρ', v: r.rho === null ? '—' : r.rho.toFixed(3) },
      { k: 'runs', v: String(r.n) },
      { k: 'noise floor', v: `±${r.floor.toFixed(2)}` },
    ],
  };
}

/** Every varying input against every measured property, as one grid. */
function buildMatrix(ds: Dataset, rows: readonly number[]) {
  const inputs = [...ds.formulation, ...ds.process].filter((f) => {
    const meta = ds.fields.get(f);
    if (!meta || meta.isConstant) return false;
    // An input that never varies across the rows in view has nothing to say
    // about any of them, and an all-grey row is worse than no row.
    const col = ds.columns.get(f);
    if (!col) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of rows) {
      const v = col[r];
      if (v === undefined || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi > lo;
  });

  const scored = inputs
    .map((f) => {
      const cells = ds.outputs.map((o) => relationship(ds, f, o, rows));
      const peak = Math.max(0, ...cells.map((c) => Math.abs(c?.r ?? 0)));
      return { field: f, cells, peak };
    })
    .sort((a, b) => b.peak - a.peak);

  return {
    rowFields: scored.map((s) => s.field),
    rowLabels: scored.map((s) => ds.fields.get(s.field)?.short ?? s.field),
    colLabels: ds.outputs.map((o) => ds.fields.get(o)?.short ?? o),
    cells: scored.map((s) =>
      s.cells.map<HeatCell>((c) => ({
        value: c?.r ?? null,
        strong: c?.clearsNoise ?? false,
        detail: c
          ? [
              { k: 'Pearson r', v: c.r === null ? '—' : c.r.toFixed(3) },
              { k: 'runs', v: String(c.n) },
            ]
          : undefined,
      })),
    ),
    flat: scored.flatMap((s) => s.cells.map((c) => ({ clearsNoise: c?.clearsNoise ?? false }))),
  };
}

/** The measured property whose middle half covers most of its own span. */
function widestProperty(ds: Dataset, rows: readonly number[]) {
  let best: { field: FieldId; iqrShare: number } | null = null;
  for (const o of ds.outputs) {
    const col = ds.columns.get(o);
    if (!col) continue;
    const s = describe(col, rows);
    const span = s.max - s.min;
    if (!(span > 0)) continue;
    const iqrShare = (s.q3 - s.q1) / span;
    if (!best || iqrShare > best.iqrShare) best = { field: o, iqrShare };
  }
  return best;
}

/** Correlation between run date and the focused property — a drift check. */
function dateDrift(ds: Dataset, rows: readonly number[], field: FieldId) {
  const col = ds.columns.get(field);
  const pts = rows
    .map((r) => ({ t: ds.experiments[r]?.date?.getTime(), v: col?.[r] }))
    .filter((p): p is { t: number; v: number } =>
      p.t !== undefined && p.v !== undefined && Number.isFinite(p.v),
    );
  if (pts.length < 4) return { r: null, n: pts.length };
  const mt = pts.reduce((s, p) => s + p.t, 0) / pts.length;
  const mv = pts.reduce((s, p) => s + p.v, 0) / pts.length;
  let num = 0;
  let dt = 0;
  let dv = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.v - mv);
    dt += (p.t - mt) ** 2;
    dv += (p.v - mv) ** 2;
  }
  if (dt === 0 || dv === 0) return { r: null, n: pts.length };
  const r = num / Math.sqrt(dt * dv);
  // Below the noise floor a drift is not worth reporting as one.
  return { r: Math.abs(r) >= 0.42 ? r : null, n: pts.length };
}

/**
 * Which end of a property is the good end.
 *
 * Taken from the user's own specification where they have set one, because a
 * frontier drawn in the wrong direction is not a weaker answer, it is the
 * opposite answer. With no constraint on a property, higher is assumed.
 */
function directionOf(state: AppState, field: FieldId): Direction {
  const c = state.target[field];
  if (!c) return 'max';
  return c.kind === 'atMost' ? 'min' : 'max';
}

const statRows = (s: ReturnType<typeof describe>, d: number) => [
  { k: 'runs', v: String(s.n) },
  { k: 'minimum', v: formatValue(s.min, d) },
  { k: 'first quartile', v: formatValue(s.q1, d) },
  { k: 'median', v: formatValue(s.median, d) },
  { k: 'third quartile', v: formatValue(s.q3, d) },
  { k: 'maximum', v: formatValue(s.max, d) },
  { k: 'mean', v: formatValue(s.mean, d) },
  { k: 'standard deviation', v: formatValue(s.sd, d) },
];
