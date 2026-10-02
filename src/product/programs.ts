import type { ProductProgramSpec } from './types.js';

/**
 * Four demonstration product programs.
 *
 * Each one answers "what physical part are we developing a material for", and
 * that answer is SYNTHETIC — the supplied dataset contains formulations and
 * measured properties, and says nothing about products, geometry or service
 * conditions. What is not synthetic is the brief: every requirement below is
 * declared as a QUANTILE of the real measured distribution and resolved against
 * the data at load time, so a program can never ask for a number this study has
 * never come near, and replacing the data file re-derives all four briefs.
 *
 * Four, not fifteen. Each has its own geometry, its own load cases, its own
 * priorities and its own insight panel, because the point of more than one is to
 * show the platform is not hardcoded around an O-ring — not to pad a menu.
 */

export const DEFAULT_PROGRAM_ID = 'automotive-seal';

const TENSILE = /tensile|strength/i;
const ELONG = /elongation|strain/i;
const CSET = /compression set|shrink/i;
const VISC = /viscosity|flow/i;
const CURE = /cure time|cycle/i;

export const PROGRAM_SPECS: ProductProgramSpec[] = [
  {
    id: DEFAULT_PROGRAM_ID,
    name: 'Automotive seal',
    shortName: 'Seal',
    noun: 'seal',
    category: 'Static seal · O-ring',
    description:
      'An elastomer O-ring sealing a fluid joint. It has to deform enough to install and conform to its groove, resist taking a permanent set while clamped for years, and survive handling without tearing.',
    objective: 'Maintain sealing force under sustained compression.',
    geometryType: 'oring',
    requirements: [
      {
        match: CSET,
        kind: 'atMost',
        q: 0.3,
        role: 'primary',
        why: 'A seal that takes a permanent set stops pushing back on its groove, and a seal that has stopped pushing back has stopped sealing. This is the requirement that defines the part.',
      },
      {
        match: TENSILE,
        kind: 'atLeast',
        q: 0.6,
        role: 'primary',
        why: 'The ring is stretched over a shaft or into a groove during assembly, and a nick or a tear at that moment is a leak for the life of the joint.',
      },
      {
        match: ELONG,
        kind: 'atLeast',
        q: 0.45,
        role: 'primary',
        why: 'It has to stretch far enough to fit, and conform to a groove that is never perfectly machined, without splitting.',
      },
      {
        match: VISC,
        kind: 'between',
        q: [0.1, 0.7],
        role: 'process',
        why: 'Thin enough to fill a small O-ring cavity completely, thick enough not to flash out of the mould.',
      },
      {
        match: CURE,
        kind: 'atMost',
        q: 0.65,
        role: 'process',
        why: 'Seals are made in very high volume, so press time is cost.',
      },
    ],
    loadCases: ['seal-compression', 'seal-high-compression', 'seal-shear', 'seal-pressure'],
    demo: { nominalLoad: 0.18, elevatedAt: 0.45, highAt: 0.75, fieldScale: 1, recoveryFloor: 0.25 },
    visual: { color: '#2a2b30', roughness: 0.62, distance: 1, lift: 0, spin: 0.22 },
    insight: [
      {
        title: 'Sealing behaviour',
        lines: [
          { label: 'Resistance to permanent set', match: CSET, note: 'Lower is better: less of the squeeze is kept when the clamp is released.' },
          { label: 'Conformability', match: ELONG, note: 'How far the compound can be stretched before it splits.' },
        ],
      },
      {
        title: 'Material integrity',
        lines: [
          { label: 'Tensile strength', match: TENSILE, note: 'Margin against tearing during assembly and handling.' },
        ],
      },
      {
        title: 'Manufacturability',
        lines: [
          { label: 'Viscosity', match: VISC, note: 'Flow into the cavity. A process property, not a mechanical one.' },
          { label: 'Cure time', match: CURE, note: 'Press cycle, and therefore cost per part.' },
        ],
      },
    ],
    cta: 'Design a better seal',
    missingMeasurements: [
      'compression set after thermal ageing at service temperature',
      'stress relaxation / retained sealing force over time',
      'fluid resistance and volume swell',
      'low-temperature flexibility',
    ],
  },

  {
    id: 'vibration-isolator',
    name: 'Vibration isolator',
    shortName: 'Isolator',
    noun: 'bushing',
    category: 'Suspension · rubber bushing',
    description:
      'A cylindrical rubber bushing bonded between an inner sleeve and an outer shell. It has to absorb large repeated deflections in every direction while staying intact and returning to shape.',
    objective: 'Absorb deformation repeatedly without losing shape or tearing.',
    geometryType: 'bushing',
    requirements: [
      {
        match: ELONG,
        kind: 'atLeast',
        q: 0.55,
        role: 'primary',
        why: 'The wall is sheared hard on every bump. Deformation tolerance is the whole function of the part.',
      },
      {
        match: TENSILE,
        kind: 'atLeast',
        q: 0.45,
        role: 'primary',
        why: 'Stands in as the durability proxy available in this study: a compound that tears at low stress will not survive millions of cycles. Fatigue itself is not measured here.',
      },
      {
        match: CSET,
        kind: 'atMost',
        q: 0.45,
        role: 'primary',
        why: 'A bushing that creeps under static preload lets the joint go slack and changes the suspension geometry.',
      },
      {
        match: VISC,
        kind: 'atMost',
        q: 0.75,
        role: 'process',
        why: 'Has to flow around a steel insert and bond to it without voids.',
      },
      {
        match: CURE,
        kind: 'between',
        q: [0.15, 0.8],
        role: 'process',
        why: 'Long enough to develop the bond to the metal, short enough to be economic.',
      },
    ],
    loadCases: ['bushing-axial', 'bushing-radial', 'bushing-shear', 'bushing-torsion'],
    demo: { nominalLoad: 0.2, elevatedAt: 0.45, highAt: 0.75, fieldScale: 1.05, recoveryFloor: 0.3 },
    visual: { color: '#26272b', roughness: 0.66, distance: 1.05, lift: 0, spin: 0.2 },
    insight: [
      {
        title: 'Isolation behaviour',
        lines: [
          { label: 'Deformation tolerance', match: ELONG, note: 'How far the wall can be sheared before it splits.' },
          { label: 'Creep under preload', match: CSET, note: 'Lower is better: the bushing keeps its installed height.' },
        ],
      },
      {
        title: 'Durability proxy',
        lines: [
          { label: 'Tensile strength', match: TENSILE, note: 'The only strength measurement in this study. Fatigue life is not measured.' },
        ],
      },
      {
        title: 'Manufacturability',
        lines: [
          { label: 'Viscosity', match: VISC, note: 'Flow around the metal insert.' },
          { label: 'Cure time', match: CURE, note: 'Bond development against cycle cost.' },
        ],
      },
    ],
    cta: 'Design a better bushing',
    missingMeasurements: [
      'dynamic stiffness and loss factor across frequency',
      'fatigue life under cyclic shear',
      'rubber-to-metal bond strength',
      'creep under sustained static load',
    ],
  },

  {
    id: 'flexible-hose',
    name: 'Flexible hose',
    shortName: 'Hose',
    noun: 'hose',
    category: 'Fluid transfer · hose wall',
    description:
      'The elastomer wall of a flexible industrial hose. It has to bend tightly without kinking, hold internal pressure, and stretch under routing loads without splitting.',
    objective: 'Bend and pressurise repeatedly without splitting.',
    geometryType: 'hose',
    requirements: [
      {
        match: ELONG,
        kind: 'atLeast',
        q: 0.9,
        role: 'primary',
        why: 'The outer wall of a tight bend is in high extension. Elongation is the first thing that runs out.',
      },
      {
        match: TENSILE,
        kind: 'atLeast',
        q: 0.4,
        role: 'primary',
        why: 'Hoop stress from internal pressure acts on the wall continuously.',
      },
      {
        match: VISC,
        kind: 'atMost',
        q: 0.75,
        role: 'process',
        why: 'Extruded rather than moulded, so it has to flow through a die and hold its section.',
      },
      {
        match: CURE,
        kind: 'atMost',
        q: 0.8,
        role: 'process',
        why: 'Continuous vulcanisation sets a ceiling on how long the compound can take to cure.',
      },
      {
        match: CSET,
        kind: 'atMost',
        q: 0.75,
        role: 'process',
        why: 'Secondary here: it matters at clamped fittings rather than along the free length.',
      },
    ],
    loadCases: ['hose-bend', 'hose-pressure', 'hose-stretch', 'hose-combined'],
    demo: { nominalLoad: 0.5, elevatedAt: 0.5, highAt: 0.8, fieldScale: 1.1, recoveryFloor: 0.35 },
    visual: { color: '#232428', roughness: 0.7, distance: 1.12, lift: 0, spin: 0.18 },
    insight: [
      {
        title: 'Flexibility',
        lines: [
          { label: 'Bend tolerance', match: ELONG, note: 'Extension available in the outer wall of a bend.' },
        ],
      },
      {
        title: 'Pressure integrity',
        lines: [
          { label: 'Tensile strength', match: TENSILE, note: 'Margin against hoop stress. No burst test exists in this study.' },
          { label: 'Set at fittings', match: CSET, note: 'Relevant where the hose is clamped, not along its length.' },
        ],
      },
      {
        title: 'Manufacturability',
        lines: [
          { label: 'Viscosity', match: VISC, note: 'Extrusion behaviour and section hold.' },
          { label: 'Cure time', match: CURE, note: 'Line speed through continuous vulcanisation.' },
        ],
      },
    ],
    cta: 'Develop a hose formulation',
    missingMeasurements: [
      'burst and proof pressure',
      'minimum bend radius before kinking',
      'ozone and weathering resistance',
      'adhesion to reinforcement plies',
    ],
  },

  {
    id: 'tire-tread',
    name: 'Tire tread',
    shortName: 'Tread',
    noun: 'tread compound',
    category: 'Tire · tread block section',
    description:
      'A representative section of tread blocks. The compound has to resist tearing at the block edges, deform and recover through every contact patch, and process consistently at very high volume.',
    objective: 'Hold block integrity through repeated contact loading.',
    geometryType: 'tread',
    requirements: [
      {
        match: TENSILE,
        kind: 'atLeast',
        q: 0.7,
        role: 'primary',
        why: 'Block edges are torn at, not pulled: tensile strength is the available proxy for chunking resistance in this study.',
      },
      {
        match: ELONG,
        kind: 'atLeast',
        q: 0.4,
        role: 'primary',
        why: 'Each block is deformed through every revolution and has to take that strain without cracking.',
      },
      {
        match: CSET,
        kind: 'atMost',
        q: 0.55,
        role: 'primary',
        why: 'Blocks that keep their deflection lose their edge geometry, and the pattern stops behaving as designed.',
      },
      {
        match: CURE,
        kind: 'between',
        q: [0.2, 0.6],
        role: 'process',
        why: 'Tread cure has to match the rest of the tire build in the same press cycle.',
      },
      {
        match: VISC,
        kind: 'between',
        q: [0.2, 0.85],
        role: 'process',
        why: 'Extruded as a profile and then built into a green tire: it has to hold its shape without tearing on the drum.',
      },
    ],
    loadCases: ['tread-normal', 'tread-shear', 'tread-combined'],
    demo: { nominalLoad: 0.2, elevatedAt: 0.5, highAt: 0.78, fieldScale: 1.15, recoveryFloor: 0.28 },
    visual: { color: '#1f2023', roughness: 0.74, distance: 1.06, lift: 0, spin: 0.16 },
    insight: [
      {
        title: 'Block integrity',
        lines: [
          { label: 'Tensile strength', match: TENSILE, note: 'Proxy for tearing and chunking at block edges.' },
          { label: 'Strain capability', match: ELONG, note: 'Deformation the block takes through each contact patch.' },
        ],
      },
      {
        title: 'Shape retention',
        lines: [
          { label: 'Compression set', match: CSET, note: 'Lower is better: the block keeps its designed edge.' },
        ],
      },
      {
        title: 'Processing',
        lines: [
          { label: 'Cure time', match: CURE, note: 'Has to match the whole-tire press cycle.' },
          { label: 'Viscosity', match: VISC, note: 'Profile extrusion and green-tire build behaviour.' },
        ],
      },
    ],
    cta: 'Develop a tread compound',
    missingMeasurements: [
      'wet grip and dry traction',
      'rolling resistance',
      'abrasion and wear rate',
      'tear energy and chunking resistance',
    ],
  },
];

export const programSpec = (id: string): ProductProgramSpec | null =>
  PROGRAM_SPECS.find((p) => p.id === id) ?? null;

export const programIds = (): string[] => PROGRAM_SPECS.map((p) => p.id);
