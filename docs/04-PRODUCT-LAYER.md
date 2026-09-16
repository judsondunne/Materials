# The product layer

What was added, why it is shaped this way, and where the line between the real dataset and the
demonstration sits.

---

## 1. The thesis

The application previously answered *"which of these 25 experiments best matches a
specification?"*. Useful, and incomplete: a formulation scientist is never developing a
specification, they are developing a **part**. The specification is downstream of the part.

So the application now answers one longer question:

```
I am developing THIS physical product.
It needs THESE material properties.
What have we already tested?
Which formulation should I start from?
What happens if I modify it?
How does that formulation behave relative to my product requirements?
What does that behaviour look like on the physical component?
What formulation should I physically test next?
And what experimental evidence supports that decision?
```

Every screen is a step in that chain, and every interaction is meant to make one link of it
obvious.

---

## 2. What is real and what is demonstration

This is the only section that matters for trust, so it is stated before anything else.

### Real, and derived from the supplied data

- The 25 experiments, their 19 inputs and their five measured properties.
- **Requirement bounds.** Every one is a quantile of that property's measured distribution,
  resolved at load (`product/resolve.ts`). No bound is a literal. Swap the data file and all
  four briefs re-derive.
- **The best historical match.** Computed by `analysis/target.ts` — the same deterministic
  ranking the Target page uses — over the real runs. Never named in code.
- **Preset formulations.** Historical presets are real experiments selected by a stated rule
  (highest measured tensile strength, lowest measured compression set, …). Model presets come
  from the existing bounded search in `analysis/search.ts`.
- **Estimated properties.** The existing kernel estimator in `analysis/estimate.ts`, with its
  support level and its contributing runs.

### Demonstration, and labelled as such everywhere it appears

- The product identities themselves. The dataset says nothing about products.
- The component geometry, the load cases, the deformation and the stress-like field.
- The mapping from measured properties to component behaviour.

### What the dataset does not contain

No geometry. No modulus. No Poisson's ratio. No stress–strain curve. No fatigue, thermal or
ageing data. No pressure rating. No rolling resistance, wet grip, abrasion or hardness.

It follows that:

- the component view is **not FEA** and is never described as one;
- a field intensity is a unitless illustrative number, never a stress in MPa;
- the severity scale tops out at *"high simulated loading"* — the application never says a part
  will fail, because nothing here could establish that;
- each programme carries a `missingMeasurements` list, so the app states what it lacks rather
  than leaving the gap to be discovered.

A unit test asserts that no product tool result mentions finite element analysis except as
something this is *not*.

---

## 3. `ProductProgram`

A first-class domain object (`product/types.ts`), declared in `product/programs.ts` and
resolved against the dataset by `product/resolve.ts`.

```
ProductProgramSpec            ProductProgram  (resolved)
  id, name, noun          →     requirements[]   concrete bounds + why + metAlone
  category, description   →     target           the same, as a TargetProfile
  objective               →     loadCases[]      resolved definitions
  geometryType            →     bestHistorical   computed from the real ranking
  requirements[]  quantiles →   fullyMatching[]  every run satisfying the whole brief
  loadCases[]  ids
  demo            synthetic engineering parameters
  visual          colour, roughness, framing
  insight         what the five properties MEAN for this part
  missingMeasurements
```

Four programmes, not fifteen: **automotive seal** (the flagship), **vibration isolator**,
**flexible hose**, **tire tread**. Each has its own geometry, load cases, priorities and
insight panel, because the point of more than one is to show the platform is not hardcoded
around an O-ring.

Requirements are declared by regular expression against the property name and by quantile, so a
programme resolves cleanly against a dataset with different columns and **drops** requirements
whose property is absent rather than inventing them.

---

## 4. The behaviour mapping

`product/behavior.ts`. A normalisation, documented as one:

| Measured property | Normalised to | Drives |
|---|---|---|
| Elongation | its observed range | deformation amplitude, ×0.78 to ×1.26 |
| Tensile strength | its observed range | field divisor, 0.70 to 1.45 |
| Compression set | its observed range | fraction of a squeeze retained after release |
| Viscosity, cure time | its observed range | **nothing mechanical**; reported as process characteristics |

Letting viscosity stiffen a component would be exactly the kind of quiet fabrication this layer
exists to avoid, so it is asserted by test that it cannot.

The claim being made is narrow and true: the direction and relative size of a change are
faithful to the measurement. Two compounds whose compression set differs recover differently,
monotonically in that number.

---

## 5. The demonstration engineering model

`product3d/warp.ts`. For each component, a **spatial warp** `W(p) → p'` and a **scalar field**
`F(p, edge) → [0,1]`, both analytic, both pure functions of rest position, load state and two
material scalars.

Properties the tests pin:

- identity at zero load, for every component;
- monotonic in load;
- continuous — a hair more load moves a surface only a hair;
- symmetric where the geometry is symmetric (pure compression on the seal);
- bounded in `[0,1]` however hard it is driven;
- concentrated where a reader of an engineering drawing would expect it — at a contact face
  under compression, on the outer fibre of a bend, at a block edge in a contact patch.

### Why the file is written twice

The TypeScript is the reference implementation: it is what the tests pin and what the CPU uses
to find the peak intensity, the hotspot region and the hit-test mesh. The GLSL below it is a
line-for-line mirror that runs per-vertex on the GPU, which is the only way a continuously
deforming mesh holds frame rate. They live adjacent so a change to one is made next to the
other.

### Normals under deformation

The warp is defined on all of space, so the deformed normal is recovered exactly, in the vertex
shader, by warping two points a hair away along stored surface tangents and crossing the
results. No CPU work, no normal recomputation, correct shading at any deformation.

### Geometry

Procedural, nothing imported. Three of the four components are solids of revolution and share
one generator: a closed 2D profile swept about an axis, split into bands so a click resolves to
a named region. The tread is built from blocks on a crowned base, with an edge-proximity
attribute so the field can concentrate where a tread block actually tears.

---

## 6. The studio

`pages/StudioPage.tsx`. Three columns — compound, component, consequence — and they are not
three panels that happen to share a page:

```
edit an ingredient
  → the estimator re-estimates the five properties
    → the behaviour mapping re-derives amplitude, tolerance and residual
      → the component's deformation and field change on screen
        → the requirement rows change with them
```

The layout is driven by **container queries** rather than viewport media queries, because the
copilot panel is a sibling that can be dragged to any width and a media query cannot see it.
Three columns only when none of them would be cramped; otherwise the performance panel moves
below the component; otherwise one column.

---

## 7. The copilot

Fifteen product tools (`ai/tools/product.ts`) on top of the existing thirty. Two rules:

1. **One path into the workspace.** Every product action goes through the same pure transition
   in `product/actions.ts` that the user's own click goes through. A test asserts that
   selecting a programme through a tool produces exactly the state clicking it does.
2. **Provenance in every result.** Measured values are marked `measured`, estimates are marked
   `estimated` with a support level, and anything from the demonstration model carries an
   `illustrative` field the model cannot overlook.

The system prompt adds a section on how much of the product layer is real, and requires the
assistant to explain what happens on screen by walking back down the chain:

```
3D EFFECT → MATERIAL PROPERTY → MEASUREMENT OR ESTIMATE → HISTORICAL EVIDENCE
```

So not *"Polymer 1 makes rubber recover"* but *"the candidate recovers more because its
compression-set estimate is X against Y, and that estimate is carried mostly by experiments A,
B and C"* — with those ids rendered as clickable evidence.

---

## 8. Performance

- Geometry is built once per programme. A slider moves a uniform, not a vertex buffer.
- Render-on-demand: a frame is drawn only when something changed or an animation is running.
  Off screen or in a hidden tab, nothing is drawn at all — but the **first** frame is always
  drawn, so a viewport that mounts while an observer still believes it is off screen cannot sit
  blank.
- The recovery script commits about 33 times a second rather than once per frame; the component
  itself is unaffected, because the deformation is a shader.
- The hit-test mesh is a quarter-resolution copy updated on the CPU only when a pick is
  actually attempted.
- Device pixel ratio is capped at 2.
- The product chooser renders four still images from one off-screen renderer rather than
  running four live contexts to look at four stationary objects.
- three.js is a separate build chunk, so it caches independently of the application's own code.
- If WebGL is unavailable the viewport says so in one line and every formulation, requirement
  and estimate on the page keeps working.

---

## 9. What a production version would need

Stated here and in the UI, per programme, because the gap is the most important thing an
interview demo can be honest about:

- **Seal** — compression set after thermal ageing, stress relaxation over time, fluid
  resistance and swell, low-temperature flexibility.
- **Isolator** — dynamic stiffness and loss factor across frequency, fatigue life under cyclic
  shear, rubber-to-metal bond strength, creep under sustained load.
- **Hose** — burst and proof pressure, minimum bend radius, ozone and weathering resistance,
  ply adhesion.
- **Tread** — wet grip, rolling resistance, abrasion rate, tear energy.

And, for the component view to become analysis rather than illustration: real geometry, a
calibrated hyperelastic material model, and a solver.
