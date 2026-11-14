/** Colour scale for speed ratios (0 = standing, 1 = free flow): red → amber → green. */

export type Rgb = readonly [number, number, number];

const STOPS: ReadonlyArray<{ at: number; color: Rgb }> = [
  { at: 0, color: [0.898, 0.282, 0.302] }, // #e5484d
  { at: 0.5, color: [0.961, 0.647, 0.141] }, // #f5a524
  { at: 1, color: [0.188, 0.643, 0.424] }, // #30a46c
];

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function speedColor(ratio: number): Rgb {
  const t = clamp01(ratio);
  for (let i = 1; i < STOPS.length; i++) {
    const lower = STOPS[i - 1]!;
    const upper = STOPS[i]!;
    if (t <= upper.at) {
      const local = (t - lower.at) / (upper.at - lower.at);
      return [
        lower.color[0] + (upper.color[0] - lower.color[0]) * local,
        lower.color[1] + (upper.color[1] - lower.color[1]) * local,
        lower.color[2] + (upper.color[2] - lower.color[2]) * local,
      ];
    }
  }
  return STOPS[STOPS.length - 1]!.color;
}

/** Same scale as 8-bit RGB, e.g. for canvas ImageData. */
export function speedColorBytes(ratio: number): Rgb {
  const [r, g, b] = speedColor(ratio);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
