# Part 2 — Build Spec: **Formulation Explorer**

> Companion to `01-PROBLEM-ANALYSIS.md`. This document specifies behaviour, structure and
> interaction — every view, every control, every state. Visual design (color, type, spacing)
> is deliberately deferred; where a visual decision affects *meaning* it is specified here.

---

## 0. Definition

**Formulation Explorer** is a single-page analytical workbench over an experiment log.
One global filter context and one global selection set are shared by five linked views.
Brushing, filtering or selecting anywhere updates everywhere.

### 0.1 Non-negotiable principles

| # | Principle | Enforcement |
|---|---|---|
| P1 | **Single source of truth.** One store, one filter set, one selection set. | No view-local query state. Views receive `(rowIds, scales, handlers)`. |
| P2 | **Filtering dims, never deletes.** | Every distribution renders the full-population reference behind the filtered one. Scatter keeps non-matching points as ghosts. |
| P3 | **Every number carries its context.** | `n`, `n_present`, support badge, caveat — rendered *with* the statistic, not in a footnote. |
| P4 | **Zero ≠ absent.** | Absent renders as `—`. Stats expose `includeAbsent` where it changes the answer. |
| P5 | **Self-evident.** | No tutorial. Defaults land on a real finding. Every control is labelled with a noun and shows its current value inline. |
| P6 | **No fabrication.** | No invented units. No predictive model at n=25. No synthetic data. |
| P7 | **Deterministic & shareable.** | Complete analysis state round-trips through the URL. |

### 0.2 Explicit non-goals
Persistence/back-end, multi-dataset upload, auth, real-time collab, a trained predictive model,
mobile-first layout (responsive down to tablet; phone gets a documented reduced layout).

---

## 1. Technical architecture

### 1.1 Stack

| Layer | Choice | Why (defensible in review) |
|---|---|---|
| Framework | **React 19 + TypeScript (`strict`, `noUncheckedIndexedAccess`)** | Brief asks for modern JS/TS. Strict flags catch the sparse-array bugs this data invites. |
| Build | **Vite** | Fast, zero-ceremony, ESM. |
| Charts | **None.** `d3-scale`, `d3-array`, `d3-quadtree`, `d3-shape` (math only) | Directly targets "evaluated on the code you write above and beyond the libraries you use". Every mark, axis, tick, brush and hit-test is authored. |
| State | **Hand-rolled store on `useSyncExternalStore`** (~60 lines) + pure selectors | Fine-grained subscriptions, zero deps, and demonstrates React internals literacy. (Zustand is the fallback if time is tight — same shape.) |
| Routing/URL | `history.replaceState` + a hand-written compact codec | Shareable analyses; also a clean, testable pure-function surface. |
| Styling | CSS Modules + design tokens (custom properties) | No runtime cost, no framework lock-in, trivially themeable (light/dark). |
| Tests | **Vitest** (unit) + **React Testing Library** (component) + **Playwright** (1 smoke journey) | The stats/selector layer is pure → cheap, high-signal tests. |
| Lint | ESLint (typescript-eslint strict) + Prettier | — |

### 1.2 Layer diagram — strict one-way dependency

```
  data/            dataset.json  (untouched, the given file)
    │
    ▼
  domain/          parse → validate → normalise → derive        ← PURE, no React
    │              (Dataset, FieldMeta, DerivedDimensions)
    ▼
  analysis/        stats kernel: correlation, histogram, KDE,   ← PURE, no React
    │              percentile, effect size, Pareto, kNN, fit
    ▼
  state/           store (filters, selection, focus, view cfg)  ← framework-adjacent
    │              + selectors (memoised, pure)
    ▼
  views/           Scatter | Drivers | Signature | Parallel | Table
    │              + Inspector | Compare | FilterRail
    ▼
  charts/          primitives: Axis, Grid, Marks, Brush,        ← dumb, prop-driven
                   Legend, Tooltip, useChartFrame
```

**Rule: `domain/` and `analysis/` import nothing from React.** They are testable with plain
Vitest and reusable in a worker. This single constraint is what makes the code review go well.

### 1.3 Module map

```
src/
  domain/
    types.ts              Branded ids, Dataset, Field, Family, DerivedDim
    parse.ts              JSON → Dataset (+ DataQualityReport)
    families.ts           family inference + mutual-exclusivity detection
    derive.ts             derived categorical dimensions, composition totals
    format.ts             per-field precision inference, number/date formatting
  analysis/
    descriptive.ts        min/max/mean/median/sd/quantile/IQR (single pass)
    correlation.ts        pearson, spearman, matrix, significance threshold
    histogram.ts          Freedman–Diaconis binning, absent bucket, shared-domain binning
    effect.ts             standardised mean difference, signature ranking
    fit.ts                OLS line, r², residuals, leverage
    pareto.ts             frontier for arbitrary objective directions
    neighbors.ts          Euclidean / cosine kNN in composition space + diff
    insights.ts           ranked auto-insight generation
  state/
    store.ts              createStore + useStore (useSyncExternalStore)
    actions.ts            typed action creators
    selectors.ts          memoised derived state (filteredIds, stats, …)
    url.ts                encode/decode analysis state
    keymap.ts             central keyboard registry
  charts/
    useChartFrame.ts      ResizeObserver + margins + scales
    Axis.tsx  Grid.tsx  Marks.tsx  BrushX.tsx  BrushXY.tsx
    Legend.tsx  Tooltip.tsx  ColorScale.ts
  views/
    scatter/  drivers/  signature/  parallel/  table/
    inspector/  compare/  filters/  palette/
  app/
    App.tsx  Shell.tsx  ViewSwitcher.tsx  FilterChips.tsx  StatusBar.tsx
```

---

## 2. Domain model

```ts
type ExperimentId = string & { readonly __brand: 'ExperimentId' };
type FieldId      = string & { readonly __brand: 'FieldId' };

type FieldRole   = 'formulation' | 'process' | 'output';
type FieldKind   = 'continuous' | 'ordinal';   // Oven Temperature is ordinal (5 levels)

interface FieldMeta {
  id: FieldId;
  label: string;
  role: FieldRole;
  kind: FieldKind;
  family: FamilyId | null;        // 'polymer' | 'carbonBlack' | … | null
  unit: string | null;            // ALWAYS null for this dataset — never invented
  decimals: number;               // inferred from observed values
  domain: readonly [number, number];
  domainPresent: readonly [number, number];  // ignoring absent rows
  presentCount: number;           // rows where value > 0
  levels?: readonly number[];     // ordinal only, e.g. [325,350,375,400,425]
  isConstant: boolean;            // zero variance → correlation undefined
}

interface Experiment {
  id: ExperimentId;               // '20170112_EXP_46'
  date: Date;                     // parsed from the key prefix
  runNumber: number;              // 46 — NOT unique, display-only
  index: number;                  // row index into the columnar store
}

interface Dataset {
  experiments: readonly Experiment[];
  fields: ReadonlyMap<FieldId, FieldMeta>;
  columns: ReadonlyMap<FieldId, Float64Array>;   // columnar, row-index aligned
  families: readonly Family[];
  derived: readonly DerivedDimension[];
  quality: DataQualityReport;
}

interface Family {
  id: FamilyId; label: string; members: readonly FieldId[];
  exclusivity: 'exactly-one' | 'at-most-one' | 'multi';   // detected, not hardcoded
  totalDomain: readonly [number, number];
}

interface DerivedDimension {          // e.g. "Filler system"
  id: string; label: string;
  levels: readonly { key: string; label: string; rowIds: Uint32Array }[];
  provenance: string;                 // human-readable rule, shown in a tooltip
}
```

**Columnar `Float64Array`** rather than an array of objects: filtering and every statistic
become tight numeric loops with no property lookups, and the same code scales to 10⁵ rows
unchanged. At n=25 this is over-engineering *that costs nothing* and signals intent.

### 2.1 `NaN` = absent-from-record; `0` = present-at-zero
The current file has no missing fields, but the parser must handle it: a field missing from an
experiment becomes `NaN` in the column and is **excluded from all statistics**, while an explicit
`0.0` is **included as "absent ingredient"**. Two different concepts, two different renderings
(`n/a` vs `—`). Conflating them is the classic silent-wrong-answer bug in this kind of tool.

---

## 3. Ingestion pipeline (pure, one pass at boot)

```
raw JSON
  ├─ 1. shape validation   outer object; each value has inputs+outputs objects
  ├─ 2. key union          union of all input/output keys across records (not just the first)
  ├─ 3. coercion           non-finite / non-numeric → NaN + quality issue recorded
  ├─ 4. columnarisation    Float64Array per field
  ├─ 5. id parsing         /^(\d{8})_EXP_(\d+)$/ → date + runNumber; non-matching → id only
  ├─ 6. field meta         role, kind, domain, decimals, presentCount, isConstant
  ├─ 7. family inference   longest-common-prefix grouping + curated label map
  ├─ 8. exclusivity scan   per family: distribution of #members-used per row
  ├─ 9. closure check      Σ formulation per row; if all ≈ const → mark as mixture, store total
  └─ 10. derived dims      one per 'exactly-one' / 'at-most-one' family + filler-system + temp
```

**Family inference is data-driven, not a hardcoded list:** group fields whose labels share a
prefix once a trailing index/qualifier is stripped (`Polymer 1..4`; `Carbon Black High/Low
Grade`). A curated `FAMILY_LABELS` map supplies display names and the filler-system rule; if a
future dataset doesn't match, fields simply fall back to `family: null` and every view still
works. **Nothing in the app hard-codes the 24 field names.**

**Mixture detection (step 9)** — compute Σ(formulation) per row; if
`sd < 0.5 && |mean − 100| < 1`, set `dataset.isMixture = true`, which enables:
composition bars, the 100% sum badge in the Inspector, and the closure caveat in Drivers.
If false, those features silently disappear. *Generic mechanism, dataset-specific payoff.*

### 3.1 `DataQualityReport` (rendered as a badge in the header, expandable)
Counts of: coerced values, out-of-schema fields, unparseable ids, constant columns,
rows whose composition deviates > 0.5 from the mixture mean, duplicate row content.
**Green check when clean** — for this dataset it *is* clean, and showing that you checked is
worth more than the check itself.

---

## 4. Analysis kernel — exact contracts

Every function is pure, `NaN`-safe, takes `(values: Float64Array, ids: Uint32Array)`, and
returns a struct that includes its own `n`.

| Function | Contract / edge cases |
|---|---|
| `describe(col, ids)` | Single pass → `{n, nPresent, min, max, mean, sd, q1, median, q3}`. `n<1` → all `NaN`. `NaN` values skipped. |
| `pearson(x, y, ids)` | Returns `{r, n, se}`. Returns `r: null` when `n<3` or either series has zero variance — **never `0`**, which would read as "no relationship". |
| `spearman(x, y, ids)` | Rank transform with **average ranks for ties** (ties are common here: many 0s), then Pearson. Exposed as a toggle; more trustworthy at n=25. |
| `significanceThreshold(n, alpha)` | Critical \|r\| from the t-distribution; used to grey weak cells. n=25 → ≈0.396. |
| `correlationMatrix(fieldsA, fieldsB, ids, method)` | O(A·B·n). Returns cells `{r, n, nPresent, support: 'ok'|'low'|'none'}`. `low` when `nPresent < 8`. |
| `histogram(col, ids, {bins, domain, separateAbsent})` | **Freedman–Diaconis** bin width with Sturges fallback; `domain` is passed in so filtered and reference histograms **share identical bins** (non-negotiable for overlay comparison). `separateAbsent` pulls `value===0` into a dedicated leading bucket for formulation fields. Degenerate domain (min===max) → single bin. |
| `smd(colA_ids, colB_ids)` | Standardised mean difference (Cohen's d, pooled sd) — the ranking metric for the Signature view. Pooled sd 0 → `null`. |
| `olsFit(x, y, ids)` | `{slope, intercept, r2, n, residuals}`; `null` when `n<3` or x is constant. Also returns per-point **leverage** so hovering a point can show its influence on the line. |
| `pareto(points, directions)` | Generic non-dominated set for any number of objectives with per-axis `'max'|'min'`. O(n²) is correct at this scale; the interface allows a sort-based O(n log n) swap. |
| `knn(rowId, k, {metric, fields})` | Euclidean (default) or cosine over formulation fields; returns neighbours **with a per-field diff** sorted by \|Δ\|. |
| `rankInsights(dataset)` | See §11. |

**Memoisation**: every selector result is cached in an LRU keyed by
`hash(filterSignature, fieldIds, options)`. The filter signature is a stable string built from
the sorted active filters, so identical states hit cache across view switches and undo.

---

## 5. Global state

```ts
interface AppState {
  // ── QUERY: reduces the working set. Global. URL-synced.
  filters: {
    ranges:   Record<FieldId, [number, number]>;       // inclusive both ends
    presence: Record<FieldId, 'any' | 'present' | 'absent'>;
    levels:   Record<DimId, Set<string>>;              // categorical facets
    dateRange: [number, number] | null;
    search: string;                                    // matches experiment id
  };

  // ── SELECTION: a pinned set of experiments. Survives filter changes.
  selection: Set<ExperimentId>;
  lastSelected: ExperimentId | null;                   // shift-click range anchor

  // ── FOCUS: transient, hover-driven, never persisted, propagates to all views.
  focus: ExperimentId | null;

  // ── VIEW CONFIG
  view: 'scatter' | 'drivers' | 'signature' | 'parallel' | 'table';
  scatter:   { x: FieldId; y: FieldId; color: ColorSpec; size: FieldId | null;
               showTrend: boolean; excludeAbsent: boolean; showPareto: ParetoSpec | null };
  drivers:   { method: 'pearson' | 'spearman'; sortBy: FieldId | null; groupByFamily: boolean };
  signature: { target: FieldId; window: [number, number]; sortBy: 'effect' | 'name' };
  parallel:  { axes: FieldId[]; colorBy: FieldId; axisBrushes: Record<FieldId, [number,number]> };
  table:     { sort: { field: FieldId; dir: 'asc'|'desc' }[]; visibleFields: Set<FieldId> };

  // ── PREFERENCES (localStorage, not URL)
  prefs: { ghosts: boolean; theme: 'light'|'dark'|'system'; reduceMotion: boolean };
}
```

### 5.1 The three-tier interaction model (the core UX decision)

| Tier | What it is | How it's created | Visual language | Scope |
|---|---|---|---|---|
| **Filter** | A predicate on a *dimension* | Range brush on any axis/histogram, facet chips, presence toggles | Non-matching rows → **ghosts** (8% opacity, no hit-test) | Global, persistent, URL |
| **Selection** | A pinned set of *rows* | Click a point/row, rubber-band brush in scatter, "select all filtered" | Matching rows → accent stroke + halo; selection bar appears | Global, persistent, URL |
| **Focus** | One transient row | Hover / keyboard focus | All views highlight that row simultaneously | Global, ephemeral |

**The rule that makes it learnable: ranges make filters, point-sets make selections.**
Dragging on a *1-D axis or histogram* is always a filter. Dragging on the *2-D plot body* is
always a selection. This is consistent across all five views, so the user learns it once.

**Selection survives filtering.** If a selected experiment falls outside the current filter, the
selection bar reads: *"3 selected · 1 hidden by filters"* with `[Show]` (relaxes the offending
filter) and `[Drop hidden]`. Silently dropping selections is the most common bug in linked-view
tools; handling it explicitly is a review-visible detail.

### 5.2 Actions (exhaustive)
`setFilterRange`, `clearFilterRange`, `setPresence`, `toggleLevel`, `setDateRange`, `setSearch`,
`clearAllFilters`, `toggleSelect`, `rangeSelect`, `addToSelection`, `selectAllFiltered`,
`clearSelection`, `dropHiddenFromSelection`, `setFocus`, `setView`, `setScatterAxis`,
`swapScatterAxes`, `setColorBy`, `toggleTrend`, `toggleExcludeAbsent`, `setPareto`,
`setCorrMethod`, `setSignatureTarget`, `setSignatureWindow`, `setParallelAxes`,
`reorderParallelAxis`, `setTableSort`, `toggleField`, `applyInsight`, `undo`, `redo`, `reset`.

**Undo/redo**: a 50-deep ring buffer of state snapshots (the state is small and serialisable).
Filter/selection actions push; hover/focus never does. `⌘Z` / `⇧⌘Z`. Cheap to implement,
disproportionately impressive, and prevents the "I lost my analysis" moment.

### 5.3 URL codec
`?v=scatter&x=tensile&y=elong&c=fillerSystem&f=visc:2200-2800;cbhg:present&s=20170113_EXP_93`

- Field ids are slugged to short stable keys from a generated map (not array indices, which
  break if the dataset changes).
- `decode()` is total: unknown keys/fields are dropped, malformed ranges are clamped to the
  field domain, and a toast reports *"Part of this link couldn't be restored"* rather than
  throwing. **Round-trip property test**: `decode(encode(s)) ≡ s` for generated states.
- Written with `replaceState` on a 250 ms trailing debounce (no history spam);
  `pushState` only on view change.

---

## 6. Layout & information architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ HEADER   Formulation Explorer · 25 experiments · Jan 2–17 2017               │
│          [data quality ✓]            [⌘K search]  [theme]  [reset]           │
├──────────────────────────────────────────────────────────────────────────────┤
│ FILTER CHIPS  Viscosity 2200–2800 ×   Filler: Silica ×   +Add filter   Reset │
├───────────────┬──────────────────────────────────────────┬───────────────────┤
│ FILTER RAIL   │  VIEW CANVAS                             │  INSPECTOR        │
│  (280px)      │  [Scatter][Drivers][Signature]           │  (320px)          │
│               │  [Parallel][Table]      ⋯ view options   │                   │
│ Outputs   ▾   │                                          │  0 selected →     │
│  histogram+   │                                          │   dataset summary │
│  range brush  │            « the active view »           │   + insight chips │
│  ×5           │                                          │                   │
│               │                                          │  1 selected →     │
│ Formulation ▾ │                                          │   experiment card │
│  family groups│                                          │                   │
│  presence +   │                                          │  2+ →  compare    │
│  amount       │                                          │        summary    │
│               │                                          │                   │
│ Process   ▾   │                                          │                   │
│  temp chips   │                                          │                   │
├───────────────┴──────────────────────────────────────────┴───────────────────┤
│ STATUS BAR   Showing 8 of 25 · 3 selected (1 hidden)  [Compare] [Export CSV] │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Why this shape:** query on the left (where scanning starts), evidence in the middle,
explanation on the right — the standard analyst triptych (Tableau/Observable/Looker). It is
immediately legible to anyone who has used a BI tool, which is the whole point of P5.

**Responsive:** ≥1440px as above. 1100–1440px: Inspector collapses to an overlay drawer
(toggle button persists). <1100px: Filter rail becomes a sheet behind a `Filters (2)` button.
<760px: single-column, view switcher becomes a segmented scroller; charts keep aspect ratio and
drop to a simplified mark set. Documented, not an afterthought.

---

## 7. Component specification

### 7.1 Header
| Element | Behaviour |
|---|---|
| Title + subtitle | `"25 experiments · Jan 2 – Jan 17, 2017"` — computed, never hardcoded. |
| **Data quality badge** | `✓ Clean` (green) or `⚠ 3 issues`. Click → popover listing each issue with the affected experiment ids (clickable → selects them). |
| **⌘K** | Opens the command palette (§7.11). Button shows the shortcut so it is discoverable without documentation. |
| Theme toggle | light / dark / system. Persisted to `localStorage` behind a try/catch (private-mode safe). |
| Reset | Clears filters + selection + view config back to defaults. Confirmation only if >3 filters are active. Undoable. |

### 7.2 Filter chips bar
- One chip per active filter: `Viscosity 2,200–2,800 ×`. `×` removes just that filter.
- Chips are **click-to-edit**: clicking opens the corresponding control in the rail and scrolls+flashes it.
- Overflow → `+3 more` popover.
- Right side: `Reset all` (disabled when no filters).
- **Hidden when no filters are active** — no empty furniture.
- `aria-live="polite"` announces the resulting count on change.

### 7.3 Filter rail

Three collapsible sections, defaulting to Outputs open, Formulation collapsed, Process open.

**A. Outputs (5 controls)** — each is a *mini histogram with a range brush*:
```
Tensile Strength                     6.8 ─────────── 15.5     [reset ×]
   ▁▃▅█▇▅▃▁▁      ← full-population reference (grey)
   ▁▃▅█▇▅▃▁▁      ← current filtered set (accent, overlaid, identical bins)
   ├────[■■■■■■]────┤
        12.4   15.5                  8 of 25 match
```
- Drag inside the track → create the range. Drag handles → resize. Drag the middle → pan the window.
- **Numeric entry**: the two bound labels are editable inputs (type + Enter). Invalid input reverts with a shake; out-of-domain is clamped.
- Double-click the track → clear this filter.
- `⇧` + drag → snap to "nice" values (whole units).
- Keyboard: focus the handle → `←/→` step by one tick, `⇧←/→` by 10, `Home/End` to domain bounds.
- Live match count under each control.

**B. Formulation (18 ingredients, grouped by family)**
Each family is a collapsible group whose header shows the **family total range** and how many
members are used (e.g. `Plasticizer · exactly one used · 16.8–23.1`). The exclusivity text is
generated by the detector — it teaches the user the data's structure for free.

Each ingredient row:
```
  Silica Filler 2        [any ▾]  ▁▃▅█▃▁   0 ── 34.6
                          ↑ any | present | absent
```
- **Presence tri-state** is the primary control (it is the question people actually ask:
  *"show me recipes that use Silica Filler 2"*).
- Setting `present` reveals the amount range brush, whose domain is `domainPresent`
  (so the 0-spike doesn't compress the useful range). This progressive disclosure keeps the
  rail scannable: 18 sliders is a wall; 18 tri-states with on-demand ranges is a menu.
- Ingredients with `presentCount === 0` render disabled with "not used in this dataset".
- A **search box** filters the ingredient list by name (useful at 18, essential at 200).

**C. Process**
- `Oven Temperature`: 5 toggle chips `325 350 375 400 425`, each with its count badge
  (`325 (7)`). Multi-select; all-on ≡ no filter. Rendered as chips, not a slider, because the
  values are discrete and unevenly sampled — a slider would imply interpolation that doesn't exist.
- `Date`: a compact 13-day timeline with a range brush and per-day run counts.

**D. Derived dimensions** (auto-generated section, only appears when detected)
`Filler system`, `Plasticizer used`, `Curing agent used` — each a chip row with counts and an
ⓘ tooltip explaining the derivation rule (`provenance`). This is the "how did it know that?"
moment for a domain reviewer.

### 7.4 View switcher
Segmented control: `Scatter · Drivers · Signature · Parallel · Table`.
Each tab has a one-line descriptor shown on hover/focus (e.g. *Signature — "what do
experiments in a target range have in common?"*), satisfying "no instruction needed".
`1`–`5` keyboard shortcuts. View config is preserved per view across switches.

---

### 7.5 VIEW A — Scatter

**Purpose (J4):** relationship between any two fields; frontier identification; selection by region.

**Controls (chart toolbar):**
| Control | Behaviour |
|---|---|
| `X:` field picker | Grouped combobox (Outputs / Process / Formulation-by-family), searchable, keyboard-navigable. Shows each field's range in the option row. |
| `Y:` field picker | Same. |
| `⇄` swap | Swaps axes. Animated (respects reduced-motion). |
| `Color:` | `None`, any continuous field (sequential ramp), or any categorical/derived dim (categorical palette). Legend is interactive: click a level → filters to it; hover → focuses that group. |
| `Size:` | `None` or a continuous field; area-proportional (√ scale), with a size legend. |
| `Trend line` | OLS fit + `r`, `r²`, `n`. Hidden automatically when `n<3` or x is constant, with the reason on hover. |
| `Exclude absent (0)` | Only enabled when either axis is a formulation field with zeros. Recomputes the fit on present-only rows and **shows both** `r(all)=+0.88, n=25` and `r(present)=…, n=6` so the user sees the difference. ★ |
| `Pareto` | Off / on. When on, per-axis direction toggles (`max`/`min`) appear; frontier points get a ring and are joined by a stepped line; non-frontier points dim slightly. |

**Marks & interaction**
- Point = experiment. Ghosts (filtered-out) drawn first at 8% opacity, not hit-tested.
- **Hover** → point scales up, a crosshair drops to both axes with the exact values, and the
  tooltip shows: id, date, x, y, color-field value, plus *percentile within the filtered set*.
  Hover also sets global `focus` → the same experiment highlights in the Inspector and Table.
- **Click** → toggle selection. `⇧`-click → range-select from anchor along the current x-sort.
  `⌘/Ctrl`-click → add without clearing.
- **Drag on plot body** → rubber-band **selection** rectangle, live count badge attached to the
  cursor (`12 experiments`). `⇧`-drag adds to the existing selection; `⌥`-drag subtracts.
- **Drag on an axis band** → range **filter** on that axis (consistent with P-model §5.1).
- `⌘`+scroll → zoom; drag with space held → pan; `0` or double-click background → reset view.
  (Plain scroll is never hijacked.)
- **Keyboard**: the plot is one tab stop; `→/←` move focus through points ordered by x,
  `↑/↓` by y, `Enter/Space` toggles selection, `Esc` clears. A visually-hidden live region
  announces the focused point. This is the accessibility feature that almost nobody ships.
- Overlapping points: 40% fill opacity + 1px stroke; hit-testing via `d3-quadtree` so the
  topmost point within 12px wins deterministically.

**Axes:** "nice" ticks from `d3-scale`, tick count driven by pixel budget, axis labels are
buttons that open the field picker, zero line drawn when the domain spans 0. Domains default to
the **full dataset** (not the filtered subset) so the frame doesn't jump while brushing —
with a `Fit to filtered` toggle for when the user wants resolution. *(Stable frames while
filtering is a small decision with a huge perceived-quality payoff.)*

**Default state:** `x = Tensile Strength`, `y = Elongation`, `color = Filler system`,
trend on. Rationale: uses all 25 rows (no sparsity caveat), shows a genuine r = +0.69
trade-off, and the color instantly reveals the Silica→high-tensile / CB→low-tensile
separation. **The app is interesting one millisecond after load, with no user input.**

**Empty/edge:** 0 rows → centred empty state (§9). 1 row → point renders, trend suppressed with
"needs 3+ points". Constant axis → flat line + "all values are 34.6" notice.

---

### 7.6 VIEW B — Drivers

**Purpose (J2):** which inputs move which outputs — and how much to trust that.

**Layout:** a 19 × 5 matrix (inputs as rows grouped by family with sticky family headers,
outputs as columns) of diverging-coloured cells.

| Element | Behaviour |
|---|---|
| Cell | Colour = signed r on a colour-blind-safe diverging ramp (blue↔orange, never red/green). Value printed when the cell is wide enough. |
| **Weak cells** | \|r\| below `significanceThreshold(n)` → desaturated to near-grey. The threshold and its `n` are printed in the legend: *"greyed = \|r\| < 0.40 (not distinguishable from noise at n=25)"*. |
| **Low-support cells** | `nPresent < 8` → diagonal hatch overlay + ⚠ in the tooltip: *"only 6 experiments contain this ingredient"*. ★ |
| Undefined cells | Constant column or n<3 → `—` on a neutral background (never 0). |
| Hover | Tooltip: r, method, n, nPresent, and a **20×20px inline sparkline scatter** of the actual points. |
| Click | Loads that pair into the Scatter view and switches to it. The single best "drill-down" affordance in the app. |
| Row header click | Selects the whole row → Signature view keyed to that input. |
| Column header click | Sorts all rows by \|r\| for that output. |
| `Method` toggle | Pearson / **Spearman**. Spearman explained in a tooltip: "rank-based; more robust to outliers and small n". |
| `Group by family` | Collapses to 7 family rows using family totals — the closure-robust lens (§3.1). |
| Caveat strip | One dismissible line above the matrix: *"Ingredients sum to 100%, so increasing one necessarily decreases others — treat correlations as associations, not causes."* Dismissal persists. |

**Recomputation:** the matrix recomputes on the *filtered* set, so brushing "Oven Temp = 425"
and watching the drivers change is a first-class analytical move. Header shows
`computed on 8 experiments` and warns below n=10.

---

### 7.7 VIEW C — Signature  ★ *the assignment's idea #2, done properly*

**Purpose (J3):** "Experiments that hit *this* property window — what did they have in common?"

**Top: the target selector**
```
  Target property  [ Tensile Strength ▾ ]        matched: 7 of 25
  ▁▂▃▅█▇▅▃▂▁   full distribution, brushable
  ├──────────[■■■■]──┤        13.7 ── 15.5      [reset]
```
Brushing here sets `signature.window` **and** the corresponding global filter (they are the same
thing — no duplicate state). Presets appear as buttons: `Top 25%`, `Bottom 25%`, `Above mean`.

**Body: ranked small multiples.** One card per input, **sorted by |effect size| descending**:

```
┌─ Polymer 1 ──────────────────── d = +1.28 ── strong ─┐
│  matched   ▁▁▂▅█▇▃              present in 7/7 (100%) │
│  all       █▁▂▃▅▃▂▁             present in 11/25 (44%)│
│  mean 22.8  vs  8.4 overall       Δ +14.4            │
└──────────────────────────────────────────────────────┘
```
- Shared bins between the two histograms (guaranteed by `histogram({domain})`).
- For formulation fields, the **presence rate** line is often the real story
  (`present in 7/7 vs 11/25`) — it's rendered as a prominent second metric, not buried.
- Effect-size labels: `|d|<0.2 negligible`, `<0.5 small`, `<0.8 moderate`, `≥0.8 strong`.
- Cards below a `negligible` threshold collapse under `Show 9 unchanged inputs`.
- Ordinal fields (Oven Temperature) render as a grouped bar of level proportions, not a histogram.

**The callout — auto-generated plain English**, pinned above the cards:
> **7 experiments have Tensile Strength ≥ 13.7** (the top quartile). **All 7 contain Polymer 1**
> (vs 44% of the dataset) and **none contain Carbon Black High Grade** (vs 24%). They average
> **23.0** Silica Filler 2 versus 11.1 overall. *Based on 7 experiments — treat as a lead, not a
> conclusion.*

*(Every figure above is real — computed from the dataset, not illustrative. The perfect
separation on Carbon Black High Grade is exactly the kind of categorical signal a
correlation-only tool renders as an unremarkable r = −0.57.)*

Generated from the ranked effect sizes by a small, fully-tested template function
(`describeSignature()`), with the sample-size hedge attached whenever `n < 10`.
**This is the single most impressive 30 seconds of the demo** and it is ~80 lines of pure code.

**Edge:** window matches 0 → "No experiments in this range. The nearest is 15.5 (20170111_EXP_17)
— [widen to include it]". Window matches all 25 → "This window includes everything; narrow it to
see a signature."

---

### 7.8 VIEW D — Parallel Coordinates

**Purpose:** high-dimensional pattern spotting across formulation → property in one frame;
also the most visually striking view.

| Element | Behaviour |
|---|---|
| Axes | Default: `Polymer total`, `Filler total`, `Plasticizer amount`, `Oven Temperature` ‖ `Viscosity`, `Tensile Strength`, `Elongation`. A visual divider separates inputs from outputs. |
| Axis picker | `Axes (7)` button → checklist grouped by role/family, drag-to-reorder within the list. Max 12 with a clear message (readability, not a technical limit). |
| Reorder | Drag an axis header along the track; other axes shift with a spring transition; drop commits. Pointer-events based → works with touch and pen. |
| **Brush on any axis** | Creates a range **filter** (consistent with §5.1). Multiple axis brushes = AND. Brushes are the same objects as the rail's filters — brush here, see the chip appear there. |
| Lines | One polyline per experiment. Colour by a chosen field (default `Tensile Strength`, sequential). Ghosts at 6% for filtered-out rows. |
| Hover | Nearest-line hit test (distance to segments, quadtree over sampled vertices); line thickens, values pop at each axis, global `focus` set. |
| Click | Toggle selection; selected lines get an accent stroke and stay above the ghosts. |
| Scale toggle per axis | `data` (own domain) vs `percentile` (uniform rank scale) — the latter makes crossing patterns readable when ranges differ wildly (Viscosity 2160–3561 vs Curing Agent 1.0–2.0). |
| Invert axis | Double-click an axis header to flip it — standard PC-plot idiom that makes "all good outcomes to the top" possible. |

---

### 7.9 VIEW E — Table

**Purpose (J1):** ground truth, sorting, export, and the accessible equivalent of every chart.

- **Virtualised rows** (windowed rendering) and a sticky first column (experiment id) + sticky
  grouped header (`Formulation ▸ Polymer ▸ …`). At n=25 virtualisation is invisible; the seam is
  what matters for review.
- **Columns:** id, date, then outputs, then process, then formulation (grouped). Column
  visibility via the same grouped checklist used by Parallel. Density toggle (comfortable/compact).
- **Sorting:** click header → asc → desc → none. `⇧`-click adds a secondary sort
  (indicator shows `1↓ 2↑`). Sorting is a stable merge sort on the index array, not the data.
- **Cells:** numbers right-aligned, tabular figures, per-field inferred precision, thousands
  separators. **Zero in a formulation column renders as a muted `—`** with `title="not used"`. ★
  Optional `Heat` toggle shades each numeric cell by its within-column percentile.
- **Rows:** click selects (with ⇧/⌘ semantics matching the Scatter), hover sets focus,
  selected rows get an accent left-border and stay pinned to the top optionally (`Pin selected`).
- **Export CSV** — exports *the current filtered, sorted, visible-column view* with a header
  comment recording the active filters. Exporting exactly what you see is a small integrity
  detail that experienced reviewers notice.
- Keyboard: full grid navigation (arrows move the focused cell, `Space` selects the row,
  `⌘A` selects all filtered), `role="grid"` with proper `aria-rowcount`/`aria-sort`.

---

### 7.10 Inspector (right rail) — three states

**State 0 — nothing selected: dataset briefing**
- `25 experiments · 18 ingredients · 5 measured properties · Jan 2–17 2017`
- Mixture badge: `Formulations sum to 100% (99.8–100.2)` with ⓘ explaining what that implies.
- 5 output mini-distributions with mean/range.
- **Insight chips** (§11) — 4–6 ranked, one-click, each a complete configured analysis.

**State 1 — one experiment: the experiment card**
| Block | Content |
|---|---|
| Header | `20170113_EXP_93` · Mon, Jan 13 2017 · `[×]` · `[Copy link]` |
| **Composition** | 100%-stacked horizontal bar segmented by family, then an indented list of the 6–10 present ingredients with amount + % of family. Absent ingredients are *not listed* (they're noise), but a `Show all 18` toggle reveals them as `—`. |
| Process | `Oven Temperature 425` with a 5-tick strip showing where it sits. |
| **Properties** | 5 bullet charts: the dataset range as a track, the filtered range as a lighter band, this experiment's value as a marker, plus the percentile (`Elongation 123.2 — highest in dataset`). Superlatives ("highest", "lowest") are computed, and they *delight*. |
| **Nearest formulations** | Top 3 by Euclidean distance over composition, each showing distance and the top-3 differing ingredients with signed deltas, and the resulting property deltas. `[Compare]` adds them to the selection. ★ |
| Outlier note | If any property has \|z\|>2: `Viscosity is unusually high (z = +3.3)`. |

**State 2 — 2+ selected: comparison summary**
Count, `[Open compare]`, a stacked list of the selected ids with a sparkline of each property's
relative position, and `Clear`.

---

### 7.11 Compare drawer (2–4 experiments)

Opens as a bottom sheet (or full panel) from the status bar or `C`.

- **Aligned composition bars**, one row per experiment, same 100% scale, same family colour order
  → differences are *visually* obvious with zero reading.
- **Difference table**: ingredients as rows, experiments as columns, showing values with the
  **largest absolute spread highlighted** and a `Only show differences` toggle (default **on** —
  showing 18 rows where 12 are identical zeros is exactly the noise a good tool removes).
- **Property comparison**: grouped bullet bars per property with the best value per row marked
  (direction-aware: the user picks `higher is better` / `lower is better` per property, default
  unset and therefore unmarked — we don't assume domain objectives).
- Add more from a searchable picker; hard cap 4 with the reason stated (`readability`).
- `Copy comparison` → markdown table to clipboard.

### 7.12 Command palette (`⌘K` / `Ctrl+K`)
One fuzzy input over a unified action index:
- Experiments (`20170113_EXP_93` → select + inspect)
- Fields (`Viscosity` → submenu: set as X / Y / colour / filter / signature target)
- Views (`Scatter`), Actions (`Reset filters`, `Export CSV`, `Toggle ghosts`)
- Insights (`Strongest relationship in the dataset`)
Recent items on empty input. `↑/↓/Enter/Esc`, full focus trap and restore.
This is how a power user is fast *and* how a novice discovers the whole feature set.

### 7.13 Status bar
`Showing 8 of 25 experiments` (aria-live) · `3 selected (1 hidden by filters)` ·
`[Compare]` `[Select all filtered]` `[Clear]` `[Export CSV]` · undo/redo arrows with tooltips.

---

## 8. Cross-cutting interaction rules

1. **Hover = focus, everywhere.** Hovering a table row highlights the scatter point, the
   parallel line and the inspector entry. 60 fps, rAF-batched, never triggers a store write that
   invalidates memoised stats (focus lives in a separate subscription slice so heavy views don't
   re-render on hover).
2. **Transitions are meaningful only.** 180 ms ease-out for axis/scale changes (so the eye can
   track marks moving), no transition for filter-driven opacity (instant feedback). All animation
   is gated behind `prefers-reduced-motion`.
3. **Everything destructive is undoable**; nothing needs a confirm dialog except `Reset` with >3
   active filters.
4. **Numbers never lie by formatting.** Precision is per-field and inferred; no value is rendered
   with more precision than the source. Thousands separators on Viscosity only (the only field
   that needs them).
5. **Consistent colour semantics:** one accent for *selection*, one neutral for *ghosts*, the
   diverging ramp only for signed correlation, sequential ramps only for continuous encodings,
   the categorical palette reserved for derived dimensions. A colour never means two things.

---

## 9. Edge-case & empty-state catalogue

| Situation | Behaviour |
|---|---|
| **Filter matches 0** | Centred state: *"No experiments match."* + **diagnosis**: "Removing `Silica Filler 2: present` would match 6." Computed by re-running the filter with each predicate dropped in turn (18 cheap passes) and reporting the best. `[Remove it]` / `[Reset all]`. ★ |
| Filter matches 1 | Everything renders; stats needing n≥2/3 show `—` with "needs N+ experiments". |
| Selection hidden by filter | Status bar discloses it; never silently dropped (§5.1). |
| Constant / all-zero column | Excluded from correlation (cell `—`), disabled in axis pickers with "no variation in this dataset". |
| `min === max` on a range control | Track renders as a single point, brush disabled, label "single value: 375". |
| n < 3 on a fit | Trend hidden + reason on hover. |
| Spearman with ties | Average ranks (unit-tested against a known fixture). |
| Malformed JSON at boot | Full-page error with the parser message and the failing key path. |
| Field missing from a record | `NaN`, excluded from stats, rendered `n/a` (distinct from `—`). Quality badge counts it. |
| Duplicate experiment ids | `JSON.parse` silently keeps the last; we compare `Object.keys().length` against the raw text's key occurrences and warn. |
| Non-finite / negative values | Coerced to `NaN` + quality issue; negatives allowed but flagged for formulation fields. |
| Corrupt/partial URL state | Restore what's valid, drop the rest, toast once. Never throws. |
| `localStorage` unavailable | Every access wrapped; prefs silently fall back to defaults. |
| Container width 0 on first paint | `useChartFrame` returns `null` until `ResizeObserver` reports >0; no NaN-width SVG. |
| Rapid brush dragging | Pointer handlers rAF-throttled; heavy recomputes wrapped in `useDeferredValue` so the brush stays at 60 fps. |
| Touch | `touch-action: none` only on brushable surfaces; larger hit targets (44px); long-press = tooltip. |
| Very long field/experiment names | CSS truncation + `title` + full value in tooltips. |
| Print | A print stylesheet that lays out the active view + active filters on one page. (Cheap; scientists print.) |

---

## 10. Performance plan

Sized for 25 rows, architected for 10⁵ — and the plan is stated in the README so the reviewer
knows it was a choice.

| Concern | Approach |
|---|---|
| Storage | Columnar `Float64Array`; row identity = index. Zero object allocation per row in hot loops. |
| Filtering | Single pass producing a reused `Uint32Array` + count. No `.filter()` chains, no intermediate arrays. |
| Derived stats | LRU-memoised on `(filterSignature, fieldIds, opts)`. View switches and undo hit cache. |
| Correlation matrix | O(A·B·n) with pre-centred column caches; recomputed only when the filtered id set changes. |
| Rendering | SVG while `marks ≤ 2000`; a single `<MarkLayer>` seam swaps to Canvas above it. Same scales, same hit-test, one component changes. |
| Hit testing | `d3-quadtree` built once per (filter, scales) change — O(log n) lookups instead of O(n) per mousemove. |
| React | `useSyncExternalStore` with per-slice selectors; `focus` is its own slice so hover never re-renders charts' data layers. `React.memo` + stable callbacks on all chart primitives. `useDeferredValue` between filter state and expensive views. |
| Table | Row virtualisation + column windowing. |
| Bundle | No chart library (the big one). Route-level code-split for Parallel + Compare. Target < 150 KB gzipped. |
| Worker seam | `analysis/` is React-free, so moving it behind a worker is a transport change only. Documented, not built. |

**Budgets (measured, reported in the README):** first paint < 1 s on mid-tier hardware;
brush drag sustained ≥ 55 fps; view switch < 100 ms; zero layout thrash in a profile trace.

---

## 11. The insight engine ★

At load (and on filter change), rank candidate findings and expose the top ones as
one-click chips. Candidates:

| Type | Rule | Example chip |
|---|---|---|
| Strongest relationship | max \|r\| with `support: ok` | *"Silica Filler 2 tracks Tensile Strength (r = +0.81)"* |
| Group difference | max \|d\| across derived-dimension levels | *"Silica-only recipes average 4.4 higher Tensile Strength than Carbon-Black-only (13.1 vs 8.7)"* |
| Process effect | strongest ordinal trend | *"Compression Set falls from 65.2 to 54.8 as oven temp rises 325 → 425"* |
| Trade-off | strongest negative output↔output r | *"Viscosity and Tensile Strength pull against each other (r = −0.48)"* |
| Frontier | Pareto set for a chosen pair | *"3 experiments are on the Tensile/Elongation frontier"* |
| Outlier | max \|z\| | *"20170111_EXP_12 has the highest Viscosity in the set (z = +3.3)"* |
| Low-support warning | high \|r\| with `support: low` | *"Carbon Black High Grade looks like the strongest driver of Viscosity — but only 6 experiments contain it"* ★ |

Each chip carries a **complete state patch**; clicking applies it (view, axes, colour, filters)
and the change is undoable. Ranking is `|effect| × supportWeight(n)`, deduplicated by field pair,
capped at 6. **All rules are generic** — nothing about this dataset is hardcoded, which is
exactly the property a reviewer will probe for.

That last chip type is the thesis of the whole app: a tool that volunteers its own caveat is a
tool a scientist can trust.

---

## 12. Accessibility

Target **WCAG 2.2 AA**, verified with axe + manual keyboard pass.

- **Every chart is keyboard-operable** (roving tabindex over marks; arrows/Enter/Esc) — not just
  reachable, *operable*.
- Every chart has `role="img"` + a generated `aria-label` summarising it in a sentence, and a
  `View as table` toggle rendering the exact underlying numbers.
- `aria-live="polite"` on the result count and on the Signature callout.
- Colour is never the only channel: correlation sign also shown by the printed value and cell
  hatching; selection also shown by stroke weight and a check affordance.
- Diverging palette is blue↔orange (deuteranopia-safe); all text ≥ 4.5:1, chart strokes ≥ 3:1.
- Visible `:focus-visible` rings everywhere; modal focus trap + restore; `Esc` closes any overlay.
- `prefers-reduced-motion` disables all transitions.
- Semantic landmarks (`header/nav/main/aside/status`), correct heading order, `<fieldset>`
  grouping in the filter rail.

---

## 13. Testing plan

**Unit (Vitest) — the highest-signal tests, all on pure modules:**
- `parse`: valid file; missing `outputs`; extra field in one record; string number; `null`;
  `Infinity`; unparseable id; empty object.
- `families`: exclusivity detection on the real data (Plasticizer ⇒ `exactly-one`); on a
  synthetic multi-use family; on a single-member family.
- `correlation`: against hand-computed fixtures; zero variance ⇒ `null`; n<3 ⇒ `null`;
  Spearman with ties; `r` invariance under linear rescale.
- `histogram`: FD binning; shared domain produces identical edges for two different subsets;
  degenerate domain; absent bucket separation.
- `pareto`: known frontier; all-dominated; ties; mixed max/min directions.
- `neighbors`: symmetry, self-exclusion, the known closest pair (`20170104_EXP_56` ↔
  `20170116_EXP_75`, d ≈ 9.9).
- `filter`: boundary inclusivity (a value exactly at the bound *is* included), AND-composition,
  empty result, presence tri-state.
- `url`: **property-based round-trip** (`decode(encode(s)) ≡ s`) + adversarial corrupt strings.
- `format`: precision inference per field; thousands separators; `—` vs `n/a`.

**Component (RTL):** filter rail updates the count; selection survives filtering and reports
hidden; keyboard selection in the table; empty state renders the correct diagnosis.

**E2E (Playwright), one journey:** load → default scatter renders 25 points → brush Tensile
≥ 12.4 → switch to Signature → callout names Silica Filler 2 → select an experiment →
inspector shows nearest neighbours → copy link → reload the link → identical state.
*That single test proves the whole thesis works end to end.*

---

## 14. Build order

| Milestone | Deliverable | Why this order |
|---|---|---|
| **M1 — Foundation** | Vite+TS, tokens, `domain/` (parse → derive) + full unit tests, columnar store, `DataQualityReport` | Everything downstream depends on the model being right. Tests first here pay for themselves. |
| **M2 — Kernel + store** | `analysis/` with tests, `useSyncExternalStore` store, selectors, filter engine, URL codec | Still zero UI; the hard logic is done and proven. |
| **M3 — Shell + Table** | Layout, view switcher, filter rail (outputs only), status bar, virtualised Table | First runnable app; the Table validates the data end-to-end visually. |
| **M4 — Chart primitives + Scatter** | `useChartFrame`, Axis, Grid, Marks, Tooltip, BrushXY, quadtree hit-test, Scatter with trend/colour/selection | The reusable primitives land here; every later view is then cheap. |
| **M5 — Filter rail complete** | Formulation tri-states + amount brushes, process chips, derived-dimension chips, filter chips bar, empty-state diagnosis | The query surface is now complete and linked. |
| **M6 — Drivers + Signature** | Correlation matrix with support/significance treatment; Signature view + `describeSignature()` | The two views that carry the domain insight. |
| **M7 — Inspector + Compare** | Experiment card, composition bar, bullet charts, kNN, compare drawer | The "depth" tier. |
| **M8 — Delight + rigor** | Insight engine, command palette, undo/redo, keyboard nav for charts, a11y pass, Parallel coordinates | Parallel is last: highest cost, lowest dependency. **Cuttable without breaking anything.** |
| **M9 — Polish** | Visual design pass, empty/loading states, print stylesheet, README with architecture + decisions + perf numbers, Playwright journey | — |

**If time runs out, cut in this order:** Parallel Coordinates → Compare drawer → undo/redo →
command palette. M1–M7 alone is already a submission that beats the field.

---

## 15. How this maps to their rubric

| Their criterion | The specific evidence |
|---|---|
| *Efficiently written & well-structured* | Strict one-way layering with a **React-free `domain/` + `analysis/`**; generic family/exclusivity/mixture detection instead of 24 hardcoded field names; one store, pure selectors, no duplicated query state. |
| *Performant* | Columnar typed arrays, single-pass filtering into a reused `Uint32Array`, LRU-memoised stats, quadtree hit-testing, rAF-throttled pointers, `useDeferredValue`, virtualised table, SVG→Canvas seam, no chart library. |
| *Robust to edge cases* | §9's 18-row catalogue, `NaN` vs `0` separation, `r = null` instead of `0`, total URL decoding, the zero-result **diagnosis** state, a tested degenerate-data fixture. |
| *Aesthetically pleasing & easy to use* | Analyst triptych layout, one consistent interaction grammar (ranges→filters, regions→selections), ghosting so context is never lost, progressive disclosure in the rail, self-describing controls, zero tutorial. |
| *Sufficient interactivity & complexity* | Five linked views sharing one context; hand-built brushing, rubber-band selection, axis reordering, quadtree hover; keyboard-operable charts; undo/redo; shareable URL state; command palette. |
| *Above and beyond the libraries* | **Every chart is authored** on `d3-scale` math. The stats kernel, the exclusivity detector, the signature generator, the insight engine and the empty-state diagnoser have no library equivalent. |

**The three moments that win the review**
1. The **Signature** callout writing a correct, hedged English sentence about what high-tensile
   recipes have in common.
2. The **low-support warning** — the app volunteering that its own strongest correlation rests
   on 6 data points.
3. **Copy link → reload → identical analysis**, with everything keyboard-operable on the way.
