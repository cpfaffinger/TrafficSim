import { describe, expect, it } from 'vitest';
import { clamp01, speedColor, speedColorBytes } from './colorScale';

describe('speedColor', () => {
  it('maps standing traffic to red and free flow to green', () => {
    expect(speedColorBytes(0)).toEqual([229, 72, 77]);
    expect(speedColorBytes(1)).toEqual([48, 164, 108]);
  });

  it('passes amber at half speed', () => {
    expect(speedColorBytes(0.5)).toEqual([245, 165, 36]);
  });

  it('interpolates between stops', () => {
    const [r, g] = speedColor(0.25);
    expect(r).toBeGreaterThan(0.898);
    expect(g).toBeGreaterThan(0.282);
    expect(g).toBeLessThan(0.647);
  });

  it('clamps out-of-range and NaN input', () => {
    expect(speedColor(-3)).toEqual(speedColor(0));
    expect(speedColor(7)).toEqual(speedColor(1));
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
