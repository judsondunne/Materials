# Formulation Study

A materials development workspace over an experiment log of 25 rubber formulations — 18
ingredients, one process parameter, five measured properties — organised around the physical
product the compound is being developed for.

```bash
npm install
npm run dev
npm test        # 351 unit tests
npm run build
```

React 19 + TypeScript (strict) + Vite + three.js. No chart library, no state library, no UI
kit: every mark, axis, brush, slider, hit-test, procedural component and deformation shader in
this app is authored here.

---

## The question this app exists to answer

Not *"what do the charts say?"* but:

> **I need a material with particular properties. Based on the experiments we have already run,
> what formulation should I investigate next?**

Everything follows from that. The first screen asks what physical product you are developing a
material for. Six destinations, in the order the work happens:

| | Why you would open it |
|---|---|
| **Dashboard** | What physical product are we developing a material for? |
| **Product studio** | The compound, the component, and how one moves the other. |
| **Target** | Which experiments came closest to your specification? |
| **Experiments** | Everything that has been run and measured. |
| **Data** | Every measurement in the study, as charts you can interrogate. |
| **Scenario lab** | Change a formulation and see where it lands. |

Compare and the single-experiment view are steps *inside* Experiments, not places of their own.

The target is global. Set `Tensile Strength ≥ 14` once and every screen knows: Experiments
marks which rows meet it, Explore fills those points, Experiment Detail scores itself against
it, the Scenario Lab draws it as a plane in 3D and holds each estimate against it. The page
lives in the URL hash path and the whole investigation in its query, so any view is one
shareable link, and the target also survives a reload via `localStorage`.

---

## What the data turned out to be

Reading the file before designing anything changed every subsequent decision.

| Finding | What it forced |
|---|---|
| The 18 non-temperature inputs **sum to 100 on every row** (99.8–100.2). It is a closed mixture: ingredients are parts of a whole, not free variables. | The Scenario Lab rebalances the other ingredients when you move one slider, so a scenario is always a compound you could really weigh out. It is also the reason no regression is fitted — the inputs are linearly dependent, so a regression on them is degenerate, not merely noisy. |
| **25 experiments across 19 inputs.** The median distance from an experiment to its own nearest neighbour is 0.35 in normalised input space. Almost all of that space is empty. | Estimation is a local weighted average, never a model. The support indicator is explicitly *relative to this study*, and says so on screen. |
| Most ingredients are **absent from 40–85% of runs** (`Plasticizer 2` appears in 4 of 25). | Zero is a formulation decision, not a missing value — but eighteen zeros would swamp four real amounts, so unused ingredients collapse behind a count. |
| Oven temperature takes **five discrete settings** (325/350/375/400/425), unevenly sampled (7/5/2/3/8). | Treated as an ordered setting, never interpolated between as if continuous. |
| **The file supplies no units for anything.** | No screen attaches one. 325 is shown as `325`, and the data-checks disclosure says why. |
| Experiment numbers repeat across dates (`EXP_56` three times) with entirely different formulations. | The full `YYYYMMDD_EXP_NN` id is the identity everywhere; nothing is grouped by the `EXP_NN` part. |
| `Tensile Strength ≥ 14, Elongation ≥ 100, Compression Set ≤ 60` is met by exactly **2 of 25**. | The specification workflow had to be excellent at "nothing matches — here is what came closest", not just at the happy path. |

---

## How the numbers are produced

Three calculations carry the product. Each is isolated, unit-tested, and explained in the UI
behind a disclosure rather than hidden.

### Ranking experiments against a specification — `analysis/target.ts`

Every constraint is scored on **its own property's observed range**, so a 300-unit miss on
viscosity and a 3-unit miss on tensile strength are weighed fairly instead of letting the
numerically largest property decide the order.

1. A constraint's **shortfall** is how far a measured value falls outside the interval you
   asked for, divided by that property's span across the study. Inside the interval it is zero.
2. An experiment's **distance** is the root-mean-square of its shortfalls. Zero means feasible.
3. Feasible experiments rank first, ordered by their **tightest remaining slack** — clearing a
   spec comfortably is a better starting point than scraping it, because the next experiment
   will move.
4. When none are feasible, the rest rank by ascending distance.

Constraints come in four shapes: `≥`, `≤`, a range, and a value ± tolerance.

### Estimating an unmade formulation — `analysis/estimate.ts`

A Gaussian-kernel-weighted average of the five nearest experiments, over inputs each scaled
to its observed range:

```
w = exp(−(d/h)²)
```

`h` is not a tuning constant. It is the **median nearest-neighbour distance among the
experiments themselves** — the scale at which this dataset considers two formulations similar.

This is deliberately not a fitted model. A local weighted average can only restate nearby
measurements: it can never return a value outside the range of the runs it drew on, and it
cannot discover a response the existing experiments do not already contain. That is a real
limit, and the UI states it rather than dressing an interpolation up as a prediction.

### Historical support — `analysis/estimate.ts`

Relative to the study's own spacing, because with 25 points in 19 dimensions there is no
absolute standard available:

| Level | Condition |
|---|---|
| *As close as this study gets* | nearest real experiment within `0.75 h` |
| *Further out than typical* | within `1.5 h` |
| *Outside the explored region* | beyond that, **or** any input set past anything ever run |

The tooltip reports the raw nearest distance, `h`, and the Kish effective sample size
`(Σw)²/Σw²` — how many experiments really contributed. The permanent caveat under every
estimate says support here is measured against this study, not against an absolute standard.

---

## The product layer, and exactly how much of it is real

The application is not about optimising abstract numbers. It is about developing an elastomer
compound for a part: an automotive seal, a vibration isolator, a flexible hose, a tire tread.
Choosing one changes the whole investigation — the specification, the starting formulation, the
3D component, the load cases, the insight panel and what the copilot knows.

That product context is **synthetic**, and the application never pretends otherwise. Three
kinds of thing are kept apart, in the code and on screen:

| | What it is | How it looks |
|---|---|---|
| **Historical data** | the supplied experiments and their measured properties | plain numbers, a `HISTORICAL` badge |
| **Data-based estimate** | the existing estimator — a weighted average of nearby real runs — applied to a formulation nobody has made | a tilde, the estimate colour, an `ESTIMATED` badge, and always a support level |
| **Demo engineering model** | the product identity, the component geometry, the load cases, the deformation and the stress-like field | an `ILLUSTRATIVE` badge on every surface that shows it |

The supplied dataset contains no geometry, no modulus, no Poisson's ratio, no stress–strain
curve, no fatigue, thermal or ageing data and no pressure rating. So the component view is
**not finite element analysis** and is never described as such; the severity read-out tops out
at *"high simulated loading"* rather than naming a load at which anything fails; and no
property the study does not measure — rolling resistance, wet grip, abrasion, fatigue life — is
ever invented. Each programme lists what a production version of it would additionally have to
measure.

What is *not* synthetic is the brief. Every requirement bound is a **quantile of the real
measured distribution**, resolved against the data at load, so a demo brief can never ask for
something this study has not come near, and replacing the data file re-derives all four.

### The two kinds of starting formulation

These are the most important distinction in the product layer and they never share a treatment:

- **Best historical match** — a run that actually happened, selected by the application's own
  deterministic target ranking against the programme's brief. Its properties are
  *measurements*. It is computed, never written down: change a requirement and it recomputes.
- **Model-suggested candidate** — a formulation nobody has made, from the bounded scenario
  search over the region the study covers. Its properties are *estimates*, and it always
  carries its historical support and the real runs behind it.

There is no third category, and nothing in the app claims to have found a physical optimum.

### How a measured property becomes a moving component

`product/behavior.ts` is a documented **normalisation**, not constitutive modelling. Each
property is placed on 0–1 against its own observed range, and exactly three things follow:

| Measured property | What it drives |
|---|---|
| Elongation | how far the component travels for a given load |
| Tensile strength | divides the illustrative field, so a stronger compound reads as less severe |
| Compression set | how much of a squeeze is kept after release |
| Viscosity, cure time | **nothing mechanical** — reported as process characteristics only |

The one claim being made is the honest one: two formulations whose compression set differs will
visibly recover differently, and the difference you see is monotonic in that measurement. The
compression-recovery script makes that concrete — compress, hold, release — with an identical
six-second script for every compound and only the residual depending on the material.

### The demonstration engineering model

`product3d/warp.ts` holds a spatial warp and a scalar field for each of the four components,
written **twice in the same file**: TypeScript as the reference implementation, which the tests
pin and the CPU uses to find the hotspot, and a line-for-line GLSL mirror that runs per-vertex
on the GPU. Both are pure functions of rest position, load state and two material scalars, so
the same inputs always produce the same picture and no vertex is ever coloured arbitrarily.

The normal under deformation is recovered by warping two points a hair away along stored
surface tangents and crossing the results — exact, and free of CPU work, which is what lets a
component follow a slider continuously. Geometry is procedural: three of the four are solids of
revolution sharing one generator, and nothing is imported.

---

## Statistical honesty

The dataset is 25 non-designed experiments of a closed mixture. Almost nothing in it supports
a causal claim, and the app is written so that it cannot accidentally make one.

- Group comparisons are phrased as description: *"median 17.3 against 0.0 — higher in this
  group"*, never *"Polymer 1 raises tensile strength"*. A unit test asserts that no phrase
  produced by `analysis/cohort.ts` contains causal vocabulary.
- Correlations are never shown bare. Every coefficient carries its sample size and the
  **noise floor** — the |r| a sample of that size must clear at α = 0.05 — and a coefficient
  below it is reported as *"indistinguishable from noise at this sample size"* rather than as
  a weak relationship.
- A cohort smaller than five is labelled **anecdotal**, with an explicit note that a difference
  in medians at that size is a fact about a handful of numbers.
- The 3D response surface is drawn on the property's **observed range**, not auto-scaled to the
  mesh. A slice that moves by 0.9 of a 56.8 observed spread is therefore drawn as the nearly
  flat sheet it is, and the app says so in words — auto-scaling would have drawn it as a
  mountain.
- Estimated values and measured values never share a treatment: estimates carry a tilde and
  the estimate colour, measurements do not.
- Where the mesh is far from any real experiment it fades out. Absence looks like absence.

---

## The copilot

A scientist can operate this application by describing what they want. The assistant sets the
specification, searches the history, changes the charts, loads and modifies scenarios, runs
sweeps and bounded searches — and the workspace visibly moves while it does.

### The language model is not the calculator

This is the constraint everything else follows from. The model interprets intent, chooses
tools, and explains what came back. It never computes, and it is not able to: **the dataset's
values are never put in its prompt.** It receives the schema — field names, observed ranges,
which inputs are a closed mixture — and nothing else. Every number it can say has to come back
from a tool call.

```
question → tool call → validated arguments → application code
        → the workspace moves → tool result → grounded answer
```

The practical consequence is that a model failure can only ever be *choosing the wrong tool*.
It cannot produce a wrong value, because it was never given the values. That is why the tool
layer is tested exhaustively and the prompt is not: if `query_experiments` counts correctly,
the answer is correct regardless of what the model does with it.

### Four kinds of claim, kept apart

| | Example | Treatment |
|---|---|---|
| Historical fact | `EXP_28` measured tensile 15.1 | stated plainly |
| Computed fact | 2 of 25 satisfy the specification | from a deterministic tool |
| Observed association | Polymer 1 is associated with tensile strength | reported with *n* and the noise floor, never as a cause |
| Model estimate | `~13.5` tensile at this formulation | tilde, the estimate colour, and its historical support — always together |

The estimator is a weighted average of nearby runs, so an estimate can never fall outside the
range of the experiments it draws on and can never reveal a response those experiments do not
already contain. Where nothing has been run it says so instead of guessing, and the assistant
is instructed to report that rather than the number.

### Tools

Forty-odd typed tools in three groups. Arguments are validated against the same declarations
the model is shown, so the contract it reads is the contract enforced.

- **Historical analysis** — querying, statistics, relationships with their noise floors, cohort
  comparison, neighbourhoods, outliers, trade-off frontiers, ranking against the specification.
- **Scenarios** — the estimator, parameter sweeps, two-variable grids, bounded search toward a
  target, local sensitivity. All of these call the *same* `analysis/estimate.ts` the lab calls,
  so a number the assistant reports and a number reached by dragging a slider are produced by
  one function.
- **Workspace** — navigation, the specification, selection, highlighting, chart axes, loading
  and modifying scenarios. Each maps to exactly one reducer in `ai/apply.ts`.

A rejection is as useful as a result: an unknown variable comes back with the real ones listed,
so the next attempt is right. `"tensile strength"`, `"Tensile_Strength"` and
`"TENSILESTRENGTH"` all resolve; `"Polymer"` is refused with the four real options, because
guessing which polymer was meant would be worse than asking.

### Nothing is claimed that did not happen

A tool result reports whether the workspace actually moved. This was a real bug found in the
browser rather than in a test: the model answered a "I need tensile above 14…" request with the
read-only ranking tool, which computes the right numbers but changes nothing, and then said it
had set the target — while the sidebar still read *Nothing specified yet*. The read-only tool
now states plainly what it did not do, and `aiTools.test.ts` pins that.

### Where the key lives

`server/` only, and it is structural rather than a matter of care:

- The variable is never `VITE_`-prefixed, so Vite cannot inline it — `import.meta.env` has no
  such key in the browser by construction.
- No file under `src/` imports anything under `server/`. The built bundle contains no provider
  URL, no client, and no key-shaped string.
- The browser talks only to `POST /api/ai/chat`. A client-supplied `system` message is
  rejected, so the prompt cannot be overridden from the page.
- `.env.*` is gitignored; `.env.example` is the only tracked env file and holds no values.

Turns are capped at eight tool iterations, the endpoint is rate-limited, requests time out,
and stopping a run aborts the upstream request rather than paying for an answer nobody will
read. The system prompt is marked cacheable, which matters because a turn makes three or four
model calls with an identical prefix.

**If the provider is unavailable, the application is unaffected.** Every analysis, the target
ranking and the whole scenario lab are computed locally and never needed the model; the panel
says it is unconfigured and the rest of the app behaves exactly as it does with a key.

---

## Architecture

```
src/
  domain/      parsing, field metadata, family inference, the variable taxonomy
  analysis/    target · cohort · estimate · search · relationships · stats  (pure, tested)
  product/     the product layer — programmes, requirement resolution, presets,
               the behaviour mapping, load cases, candidates, state transitions
  product3d/   the demonstration engineering model — procedural geometry, the warp and
               field (TS + GLSL), deforming materials, overlays, the scene, the timeline
  state/       app state, store, router, URL codec
  charts/      Scatter, Surface3D, the projection and mesh model, scales
  components/  the shared vocabulary, plus `product/` and `copilot/` surfaces
  ai/          the copilot's protocol, tool registry, and the single apply path
  pages/       one file per workspace
server/        the AI endpoint: the provider key lives here and nowhere else
```

Every product-layer state change is a **pure function** in `product/actions.ts`, and both the
interface and the copilot go through it. "The AI moved the slider" is therefore literally true
rather than a parallel code path that happens to agree — and the tests assert that selecting a
programme through a tool produces exactly the state that clicking it does.

No scientific calculation lives in JSX. Every string like `"Polymer 1"` or `"Tensile Strength"`
is looked up through `domain/` — field metadata, ranges, decimals, category and short label are
all derived from the file at load, so nothing is hardcoded to this particular dataset. Drop in
a file with different ingredients and the taxonomy, the families, the mixture detection, the
axis defaults and the example specification all re-derive.

Progressive disclosure is the one mechanism for depth: **the answer**, then *why*, then the
arithmetic. A page can carry a lot of analysis and still open quietly.

---

## Deployment

Vercel, with no configuration beyond one environment variable.

```bash
vercel            # preview
vercel --prod     # production
```

Or import the repository at vercel.com — `vercel.json` already declares the framework preset,
the build command and the output directory, so the defaults are correct on the first try.

**The one setting that matters.** The copilot's provider key is server-side and is not in the
repository. Without it every part of the app works and the copilot says it is unconfigured
rather than failing when someone first types. To turn it on, add to the Vercel project under
Settings → Environment Variables:

| Variable | Value |
|---|---|
| `OPENROUTER_API_KEY` | your key from https://openrouter.ai/keys |
| `OPENROUTER_MODEL` | optional; defaults to `anthropic/claude-sonnet-5` |
| `OPENROUTER_APP_URL` | optional; your deployment URL, for attribution |

The key is read inside the serverless function and never reaches the browser. It has no
`VITE_` prefix, so Vite cannot inline it into the client bundle even by accident.

**How the endpoint exists in both places.** In development `POST /api/ai/chat` is Vite dev
middleware; in deployment it is a serverless function under `api/ai/`. Both are thin routing
shims over the same handlers in `server/handlers.ts`, so there is one implementation of the
endpoint rather than one per environment. The chat function is given a 60-second ceiling
because the agent takes several model round trips before it has an answer, and the platform
default cuts the stream off mid-reasoning.

Routing is hash-based (`/#/data`), so no SPA rewrite rules are needed: every URL is served by
the same `index.html` and the client reads the fragment.


## Tests

341 unit tests over the analytical and product layers — the parts where being wrong is
invisible. No test depends on a rendered pixel; the state and the maths driving the picture are
what is pinned.

| File | Covers |
|---|---|
| `target.test.ts` | constraint evaluation, normalisation fairness, ranking order, feasible/infeasible/conflict-only, seeding |
| `estimate.test.ts` | scales, kernel weights, never-NaN at every corner, output-range containment, extrapolation detection, mixture rebalancing, support thresholds |
| `cohort.test.ts` | group comparison, small-cohort reliability, the no-causal-language assertion, correlations and noise floors |
| `state.test.ts` | routing, URL round-trip of every constraint kind, hostile-input decoding, selectors, store, the variable taxonomy |
| `parse.test.ts` `families.test.ts` `stats.test.ts` | loading, degenerate datasets, the statistical primitives |
| `product.test.ts` | requirement resolution from quantiles, best-historical-match computation, preset derivation and determinism, the behaviour mapping's monotonicity and its refusal to let a process property touch the mechanics, the warp (identity at rest, monotonic in load, symmetric where the geometry is), the field (bounded, zero at rest, concentrated where it should be), the recovery script, every product state transition |
| `aiTools.test.ts` | the tool layer with no model involved: counts checked against an independent pass over the columns, closed-mixture totals held after rebalancing, estimates contained in the observed range, the search's determinism, refusal of a percentage change on an absent ingredient, and that no tool throws on any of seven malformed argument shapes |
| `aiApply.test.ts` | the model→state boundary: malformed actions rejected at the protocol, invented experiments and properties discarded, scenario inputs clamped to what a slider allows, partial changes merged rather than replacing a formulation, and that applying a batch never mutates the state it was given |
| `productTools.test.ts` | the copilot's product tools: provenance in every result, refusal instead of guessing, and the assertion that a tool-driven action produces the same state as the user's own click |
