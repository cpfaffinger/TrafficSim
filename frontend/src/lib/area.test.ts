import { describe, expect, it } from 'vitest';
import { bboxAreaKm2, bboxCentre, bboxSizeKm, boxAround, formatKm2, proposeArea, resizeBbox, roundBbox } from './area';

describe('import area', () => {
  it('builds a square of the requested size around a point', () => {
    const b = boxAround(48.2082, 16.3738, 1.5);
    const { widthKm, heightKm } = bboxSizeKm(b);
    expect(widthKm).toBeCloseTo(1.5, 6);
    expect(heightKm).toBeCloseTo(1.5, 6);
    expect(bboxAreaKm2(b)).toBeCloseTo(2.25, 6);
    expect(bboxCentre(b).lat).toBeCloseTo(48.2082, 9);
  });

  it('resizes around the same centre with a minimum side', () => {
    const b = resizeBbox(boxAround(48.2, 16.37, 1), 2, 0.01);
    const { widthKm, heightKm } = bboxSizeKm(b);
    expect(widthKm).toBeCloseTo(2, 6);
    expect(heightKm).toBeCloseTo(0.1, 6);
    expect(bboxCentre(b).lon).toBeCloseTo(16.37, 9);
  });

  it('proposes the result box when it is district-sized', () => {
    const district = boxAround(48.2, 16.37, 1, 0.8);
    expect(proposeArea({ latitude: 48.2, longitude: 16.37, bbox: district })).toEqual(district);
  });

  it('falls back to a 1.5 km square for points, cities and degenerate boxes', () => {
    const check = (bbox: readonly number[] | null) => {
      const area = proposeArea({ latitude: 48.2, longitude: 16.37, bbox });
      expect(bboxAreaKm2(area)).toBeCloseTo(2.25, 4);
    };
    check(null);
    check(boxAround(48.2, 16.37, 20)); // a city
    check(boxAround(48.2, 16.37, 0.01)); // a single building
    check([16.37, 48.2, 16.37, 48.2]);
    check([1, 2, 3]);
  });

  it('formats and rounds', () => {
    expect(formatKm2(2.254)).toBe('2.25');
    expect(formatKm2(12.34)).toBe('12.3');
    expect(roundBbox([16.12345678, 48.1, 16.2, 48.2])).toEqual([16.123457, 48.1, 16.2, 48.2]);
  });
});
