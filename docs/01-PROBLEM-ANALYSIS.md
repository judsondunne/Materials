# Part 1 — Problem Breakdown & Dataset Analysis

> Everything in this document is derived from the two source files, not assumed.
> Every number below was computed from `UncountableFrontEndDataset.json`.

---

## 1. Decoding the assignment

The brief is short, but it hides a strict ranking. Read it literally:

| Stated criterion | Weight | What it actually tests |
|---|---|---|
| **Code Quality** | #1 | Structure, separation of concerns, *performance*, *robustness to edge cases*. They said "efficiently written and well-structured" and "performant and robust to edge cases" — that is a code-review rubric, not a vibes rubric. |
| **UX** | #2 | Aesthetics, *learnability without instruction*, and "sufficient interactivity and **complexity** to demonstrate frontend ability". |

Three sentences in the brief are load-bearing and most candidates skim them:

1. **"A user should not need additional instruction … beyond … that which is self-evident from the design."**
   → No tutorial modal. No README-dependency. The default state on first paint must already
   be showing a *real, interesting result*, and every affordance must be self-describing.

2. **"You will be evaluated on the code you write and functionality you add *above and beyond the libraries you use*."**
   → This is an explicit warning against `import Plotly from 'plotly'` and calling it a day.
   Value accrues to the layer *you* author: the stats kernel, the interaction model, the
   linked-view state machine, the chart primitives. **Decision: build charts on `d3-scale` /
   `d3-array` / `d3-quadtree` (math only) and hand-author every mark, axis, brush and hit-test.**
   Zero chart libraries. This is the single highest-leverage scoring decision in the project.

3. **"one or more views"** + the three example ideas.
   → The examples (scatter of selected properties; histograms of inputs for a target output range;
   filter + query) are a *floor*, not a ceiling. A submission that does exactly the three bullets
   as three disconnected tabs is a "meets expectations." The differentiator is making them **one
   linked analytical surface** where every view shares one filter context and one selection.

### Who is reviewing this
Uncountable builds the R&D data platform for materials/chemicals labs. The reviewer looks at
formulation datasets all day. **Domain literacy is a free multiplier**: if the UI demonstrates
that the author figured out what this data *is*, it reads as "this person could ship on our
product on day one." Section 3 below is where that multiplier gets earned.

---

## 2. Hard facts about the dataset

| Fact | Value |
|---|---|
| Experiments | **25** |
| Input fields | **19** (identical key set in every record — verified) |
| Output fields | **5** (identical key set in every record — verified) |
| Non-numeric / missing values | **0** |
| Key format | `YYYYMMDD_EXP_<n>` — all 25 match; **date is parseable** |
| Date span | 2017-01-02 → 2017-01-17 (13 distinct days, 1–4 runs/day) |
| File key order | **Not sorted** — must not rely on insertion order for time |
| `EXP_<n>` collisions | `EXP_56` appears 3×, `EXP_46`/`EXP_74` 2× → **the experiment number is not a unique id**; the full key is |

**Outputs (the measured properties):**

| Output | min | max | mean | sd | implied precision |
|---|---|---|---|---|---|
| Viscosity | 2160.8 | 3561.2 | 2545.4 | 306.4 | 1 dp |
| Cure Time | 2.84 | 3.98 | 3.31 | 0.29 | 2 dp |
| Elongation | 66.4 | 123.2 | 93.9 | 13.1 | 1 dp |
| Tensile Strength | 6.8 | 15.5 | 11.5 | 2.4 | 1 dp |
| Compression Set | 42.7 | 71.4 | 60.5 | 7.0 | 1 dp |

> **No units are given anywhere in the source data.** The app will *not* invent them
> (`cP`, `psi`, `%`…). Fabricated units are exactly the kind of error a materials reviewer spots
> instantly. Units are modelled as an optional, empty-by-default annotation.

---

## 3. The latent structure (this is the part that wins)

### 3.1 It is a constrained mixture, not 19 free variables
Summing the 18 non-temperature inputs for every experiment:

```
min 99.80   max 100.20   mean 100.01
```

**Every recipe sums to 100.** These are weight-% / parts-per-hundred of a *formulation*.
Two consequences the UI must respect:

- **Compositional closure**: the inputs are not independent. Raising one ingredient
  mechanically lowers others, which manufactures spurious correlations. Any correlation UI
  that doesn't acknowledge this is naive. → we surface it as a one-line, dismissible caveat
  attached to the correlation view, not as a wall of text.
- A **"Composition" visual** (100%-stacked bar / donut by family) is the *correct* primary
  representation of an experiment — far better than 19 anonymous numbers in a row.

### 3.2 `Oven Temperature` is a process parameter, not an ingredient
It takes exactly **5 discrete values: 325, 350, 375, 400, 425** (n = 7/5/2/3/8).
It is not part of the 100% sum. Lumping it into an "inputs" list with Polymer 3 is a
domain error. → The app splits inputs into **Formulation (18 ingredients)** and
**Process (1 parameter)**, and treats Oven Temperature as an ordered categorical facet
(5 chips) *and* as a numeric axis.

### 3.3 Ingredients form families, and several families are choose-exactly-one

| Family | Members | Per-experiment total | Members used |
|---|---|---|---|
| Polymer (base) | 1–4 | 22.8 – 39.7 (mean 33.8) | 1–3 |
| Carbon Black (filler) | High / Low Grade | 0 – 42.6 | 0–2 |
| Silica Filler (filler) | 1, 2 | 0 – 41.4 | 0–2 |
| **Plasticizer** | 1, 2, 3 | 16.8 – 23.1 | **exactly 1, always** |
| Co-Agent | 1, 2, 3 | 2.1 – 5.8 | 1–2 |
| **Curing Agent** | 1, 2 | 1.0 – 2.0 | **exactly 1, always** |
| Additives | Antioxidant, Coloring Pigment | 0 – 9.9 | 0–2 |

Total filler (CB + Silica) is near-constant: **30.4 – 42.6, mean 36.9, sd 3.6** — the two filler
chemistries **trade off against each other**.

**This unlocks derived categorical dimensions that exist nowhere in the raw JSON:**

| Derived dimension | Levels (counts) |
|---|---|
| `Plasticizer used` | P3 (11), P1 (10), P2 (4) |
| `Curing agent used` | CA2 (13), CA1 (12) |
| `Filler system` | Silica-only (10), Hybrid (9), CB-only (6) |
| `Oven Temperature` | 325 (7), 350 (5), 375 (2), 400 (3), 425 (8) |

These are genuinely explanatory. Grouped means:

```
Tensile Strength   CB-only 8.68  |  Hybrid 11.51  |  Silica-only 13.12
Viscosity          CB-only 2794  |  Hybrid  2558  |  Silica-only 2385
Elongation         CB-only 83.6  |  Hybrid  94.2  |  Silica-only 99.8
Cure Time          CuringAgent1 3.49  vs  CuringAgent2 3.14
Compression Set    325°F 65.2  →  425°F 54.8   (monotone-ish decline)
```

A scatterplot of `Curing Agent 1` (amount) vs `Cure Time` shows r = +0.66 and is *misleading*:
since exactly one curing agent is ever used, the real effect is a **two-level categorical
choice**, not a dose-response. Detecting mutual exclusivity at load time and offering these as
faceting dimensions (box plots / grouped distributions) is the deepest insight available in this
dataset — and no off-the-shelf charting tool will do it for you.

### 3.4 Zero means *absent*, not *measured as zero*
**54% of the formulation matrix is zero** (245 of 450 cells). Each experiment uses only
**6–10 of the 18 ingredients** (mean 8.2). So:

- Zeros must render as **"—" (absent)** in muted style in the table, never as a bold `0.0`.
- Histograms of an ingredient must separate the **absent** bucket from the amount distribution,
  or the shape is a meaningless spike at 0.
- Correlations computed across the absent rows are really measuring *presence*, not *dose*.
  → The scatter view offers **"exclude absent (0) rows from the fit"** and reports both `n` and
  `n_present`. This one toggle is worth more than three extra chart types.

### 3.5 Signal worth designing defaults around

Strongest input→output relationships (Pearson, all 25 rows):

```
Carbon Black High Grade → Viscosity          r = +0.884   (n_present = 6  ⚠ low support)
Polymer 4               → Elongation         r = -0.822   (n_present = 11)
Plasticizer 2           → Compression Set    r = -0.817   (n_present = 4  ⚠ low support)
Silica Filler 2         → Tensile Strength   r = +0.813   (n_present = 11)
Polymer 1               → Tensile Strength   r = +0.730   (n_present = 11)
Plasticizer 1           → Compression Set    r = +0.708   (n_present = 10)
Curing Agent 1          → Cure Time          r = +0.660   (categorical artifact — see 3.3)
Oven Temperature        → Compression Set    r = -0.507   (n = 25, real process effect)
```

Output↔output (all 25 rows, no sparsity caveat):
```
Elongation ↔ Tensile Strength   r = +0.692
Viscosity  ↔ Compression Set    r = +0.492
Viscosity  ↔ Tensile Strength   r = -0.483
Elongation ↔ Compression Set    r = -0.485
```

Pareto frontier (maximise Tensile **and** Elongation) — 3 of 25 experiments:
```
20170111_EXP_17   T 15.5   E 102.6
20170109_EXP_28   T 15.1   E 108.2
20170113_EXP_93   T 13.5   E 123.2
```

Nearest-neighbour pairs in formulation space (Euclidean over 18 ingredients):
```
 9.9   20170104_EXP_56  ↔  20170116_EXP_75      (closest pair)
14.6   20170113_EXP_74  ↔  20170115_EXP_10
78.6   20170105_EXP_42  ↔  20170111_EXP_12      (most different pair)
```

Outliers (|z| > 2): `20170111_EXP_12` Viscosity 3561.2 (z +3.3), `20170116_EXP_41` Viscosity
3260.8 (z +2.3) — both are **Carbon-Black-High-Grade-heavy**, consistent with 3.5's top row.

---

## 4. Statistical hazards the UI must handle honestly

These are the traps. Handling them visibly is a *feature*, not a disclaimer.

| Hazard | Reality here | UI response |
|---|---|---|
| **Tiny n** | n = 25. Critical \|r\| ≈ 0.40 at p = 0.05. | Show `n` next to every r; grey out \|r\| below the significance threshold for the current n. |
| **Sparse support** | The #1 and #3 correlations rest on 6 and 4 non-zero points. | "Low support" badge when `n_present < 8`; hatch those cells in the driver matrix. |
| **Compositional closure** | Inputs sum to 100 → induced negative correlations. | One-line caveat on the correlation view; offer family roll-ups as an alternative lens. |
| **Multiple comparisons** | 19 × 5 = 95 correlations tested → ~5 false positives at p<0.05 by chance. | Sort by \|r\| but never label anything "significant" without the n-aware threshold; the wording is "strongest observed", not "proven". |
| **Categorical masquerading as continuous** | Curing Agent / Plasticizer (see 3.3). | Auto-detect mutual exclusivity; offer group comparison instead of a dose-response fit. |
| **Outliers driving fits** | 2 high-viscosity points. | Trend line recomputes live on the filtered set; hovering a point shows its leverage on the current fit. |
| **Prediction temptation** | 19 predictors, 25 rows — any regression model is underdetermined and dishonest. | **No predictive model.** The "sandbox" feature is explicitly a *nearest-neighbour lookup over measured history*, labelled as such. |

---

## 5. The user and their jobs-to-be-done

The persona is a formulation scientist / R&D lead with an existing experiment log.
Six real questions, in the order they actually occur:

| # | Job | Answered by |
|---|---|---|
| J1 | "What's in this dataset — what did we run, and over what ranges?" | Overview strip + table |
| J2 | "Which ingredients drive which property?" | Drivers matrix |
| J3 | "Show me everything that hit **Tensile ≥ 14** — what did those recipes have in common?" | **Signature view** (the brief's idea #2, done right) |
| J4 | "What's the trade-off between two properties, and who's on the frontier?" | Scatter + Pareto overlay |
| J5 | "Compare these three recipes side by side." | Compare drawer |
| J6 | "Tell me everything about *this* experiment, and what's most like it." | Inspector + nearest neighbours |

J3 is the money question — it is *inverse design*, which is literally what Uncountable's
customers do. It is also the brief's second bullet. We make it a first-class view.

---

## 6. What the median submission will look like (and how we beat it)

| The typical submission | This build |
|---|---|
| Three tabs: Scatter / Histogram / Table, each with its own dropdowns | **One workbench**: one filter context + one selection, shared by five linked views |
| Plotly/Recharts with default styling | Hand-authored SVG marks, axes, brushes, quadtree hit-testing on `d3-scale` math only |
| Treats all 19 inputs as interchangeable numbers | Formulation vs. process split, 7 families, derived categoricals, absent≠zero |
| Correlations printed with 3 decimals and no context | `n`, `n_present`, low-support hatching, significance-aware greying, closure caveat |
| Blank first paint with "select a property to begin" | First paint already shows a real finding + ranked insight chips |
| Filter → chart redraw | Brush anywhere → everything re-renders; non-matching rows persist as **ghosts** so context is never lost |
| State lives in `useState` in the page component | Typed columnar store + pure selectors + URL-serialised analysis state (every view is a shareable link) |
| No empty state | Zero-result state names the *most restrictive filter* and offers one-click relax |
| Mouse only | Full keyboard operability, incl. arrow-key traversal of scatter points; every chart has an accessible table equivalent |

---

## 7. Product thesis

> **"Formulation Explorer" — a linked-view workbench that turns 25 rows of JSON into an
> answerable question space, and is honest about what 25 rows can and cannot tell you.**

Three principles, in priority order, that resolve every later design argument:

1. **One shared context.** There is exactly one filter set and one selection set in the app.
   Every view reads them and writes them. No view owns private query state.
2. **Never lose the whole.** Filtering dims, it does not delete. The unfiltered population stays
   visible as ghosts/reference distributions so a user always sees *the filter's effect*, which
   is the actual insight.
3. **Show your work.** Every derived number travels with its `n`, its support, and its caveat.
   The tool is a colleague, not an oracle.
