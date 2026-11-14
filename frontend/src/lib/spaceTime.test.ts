import { describe, expect, it } from 'vitest';
import { binSpeedRatios } from './spaceTime';

describe('binSpeedRatios', () => {
  it('averages speeds per cell relative to the desired speed', () => {
    const ratios = binSpeedRatios(
      [
        { position: 1, speed: 10 },
        { position: 4, speed: 0 },
        { position: 55, speed: 5 },
      ],
      100,
      10,
      10,
    );

    expect(ratios[0]).toBeCloseTo(0.5);
    expect(ratios[5]).toBeCloseTo(0.5);
    expect(Number.isNaN(ratios[1]!)).toBe(true);
  });

  it('wraps positions outside the ring and keeps the last cell in range', () => {
    const ratios = binSpeedRatios(
      [
        { position: 100, speed: 10 },
        { position: -1, speed: 10 },
        { position: 99.999, speed: 10 },
      ],
      100,
      4,
      10,
    );

    expect(ratios[0]).toBeCloseTo(1);
    expect(ratios[3]).toBeCloseTo(1);
  });
});
