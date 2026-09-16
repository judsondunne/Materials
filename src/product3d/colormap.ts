/**
 * The field colour ramp.
 *
 * A restrained engineering sequence — deep blue through teal and olive to a
 * muted red — rather than a saturated rainbow. Six stops, interpolated linearly
 * in sRGB, defined once and used by both the shader and the on-screen legend so
 * the two cannot disagree about what a colour means.
 */

export const RAMP: { at: number; rgb: [number, number, number] }[] = [
  { at: 0.0, rgb: [0.12, 0.24, 0.43] },
  { at: 0.2, rgb: [0.16, 0.47, 0.57] },
  { at: 0.4, rgb: [0.29, 0.6, 0.47] },
  { at: 0.6, rgb: [0.69, 0.62, 0.25] },
  { at: 0.8, rgb: [0.77, 0.44, 0.2] },
  { at: 1.0, rgb: [0.8, 0.18, 0.14] },
];

export function rampColor(t: number): [number, number, number] {
  const x = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  for (let i = 0; i < RAMP.length - 1; i++) {
    const a = RAMP[i]!;
    const b = RAMP[i + 1]!;
    if (x <= b.at) {
      const f = (x - a.at) / (b.at - a.at || 1);
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f,
      ];
    }
  }
  return RAMP[RAMP.length - 1]!.rgb;
}

export function rampCss(t: number): string {
  const [r, g, b] = rampColor(t);
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgb(${to(r)}, ${to(g)}, ${to(b)})`;
}

/** A CSS gradient of the whole ramp, for the legend bar. */
export const rampGradient = (): string =>
  `linear-gradient(90deg, ${RAMP.map((s) => `${rampCss(s.at)} ${Math.round(s.at * 100)}%`).join(', ')})`;

export const RAMP_GLSL = /* glsl */ `
vec3 rampColor(float t) {
  float x = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(${RAMP[0]!.rgb.join(', ')});
  vec3 c1 = vec3(${RAMP[1]!.rgb.join(', ')});
  vec3 c2 = vec3(${RAMP[2]!.rgb.join(', ')});
  vec3 c3 = vec3(${RAMP[3]!.rgb.join(', ')});
  vec3 c4 = vec3(${RAMP[4]!.rgb.join(', ')});
  vec3 c5 = vec3(${RAMP[5]!.rgb.join(', ')});
  if (x < 0.2) return mix(c0, c1, x / 0.2);
  if (x < 0.4) return mix(c1, c2, (x - 0.2) / 0.2);
  if (x < 0.6) return mix(c2, c3, (x - 0.4) / 0.2);
  if (x < 0.8) return mix(c3, c4, (x - 0.6) / 0.2);
  return mix(c4, c5, (x - 0.8) / 0.2);
}
`;

/** Legend labels. Deliberately qualitative: the scale is illustrative. */
export const LEGEND_STOPS = ['low', 'moderate', 'high'] as const;
