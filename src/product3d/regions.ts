import type { GeometryType } from '../product/types.js';

/**
 * The named regions of each component.
 *
 * Separate from the geometry generator so that anything wanting to talk about a
 * region — the hover read-out, the copilot's focus tool, the system prompt — can
 * do so without pulling in a mesh builder.
 */

export interface RegionInfo {
  id: string;
  label: string;
  /** What this part of the component does, in the product's own language. */
  note: string;
}

export const REGIONS: Record<string, RegionInfo> = {
  'contact-top': {
    id: 'contact-top',
    label: 'Upper contact face',
    note: 'Where the seal bears against the top of its groove. This is the surface the clamp load passes through.',
  },
  'contact-bottom': {
    id: 'contact-bottom',
    label: 'Lower contact face',
    note: 'The reaction face at the bottom of the groove.',
  },
  'outer-equator': {
    id: 'outer-equator',
    label: 'Outer equator',
    note: 'The free outer surface. It bulges as the section is squeezed, and it is the fibre in most extension.',
  },
  'inner-bore': {
    id: 'inner-bore',
    label: 'Inner bore',
    note: 'The inside face of the ring, stretched over the shaft during assembly.',
  },
  bore: {
    id: 'bore',
    label: 'Bonded bore',
    note: 'The inner sleeve interface. Load enters the rubber here, so the illustrative field concentrates against it.',
  },
  'outer-wall': {
    id: 'outer-wall',
    label: 'Outer wall',
    note: 'The free outer surface, which barrels outward under axial load.',
  },
  'top-face': {
    id: 'top-face',
    label: 'Top face',
    note: 'The end face the axial load is applied through. It carries the whole load into the wall.',
  },
  'bottom-face': {
    id: 'bottom-face',
    label: 'Bottom face',
    note: 'The reaction face at the other end of the bushing, where the load leaves it again.',
  },
  'inner-wall': {
    id: 'inner-wall',
    label: 'Bore wall',
    note: 'The pressurised inside of the hose. Hoop loading is highest here.',
  },
  'end-face': {
    id: 'end-face',
    label: 'Cut end',
    note: 'The sectioned end of this length of hose. A real hose continues; this is where the section stops.',
  },
  'contact-face': {
    id: 'contact-face',
    label: 'Contact face',
    note: 'The road-facing surface of the tread block, flattened into the contact patch.',
  },
  'block-edge': {
    id: 'block-edge',
    label: 'Block edge',
    note: 'The leading and trailing edges of the block. Free to move, so they strain most and are where chunking starts.',
  },
  'groove-wall': {
    id: 'groove-wall',
    label: 'Groove wall',
    note: 'The side of the groove between blocks.',
  },
  'block-top': {
    id: 'block-top',
    label: 'Block base',
    note: 'Where the block meets the tread base and the carcass below it.',
  },
};

/** Which regions each component has, in the order the generator emits them. */
export const REGIONS_BY_GEOMETRY: Record<GeometryType, string[]> = {
  oring: ['outer-equator', 'contact-top', 'inner-bore', 'contact-bottom'],
  bushing: ['bottom-face', 'outer-wall', 'top-face', 'bore'],
  hose: ['end-face', 'outer-wall', 'inner-wall'],
  tread: ['contact-face', 'block-top', 'groove-wall', 'block-edge'],
};

export const regionInfo = (id: string | null): RegionInfo | null =>
  id ? (REGIONS[id] ?? null) : null;
