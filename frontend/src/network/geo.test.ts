import { describe, expect, it } from 'vitest';
import { fromScene, LocalTangentPlane, toScene } from './geo';

describe('LocalTangentPlane', () => {
  const plane = new LocalTangentPlane({ lat: 48.2082, lon: 16.3738 });

  it('maps the origin to zero', () => {
    expect(plane.toLocal(16.3738, 48.2082)).toEqual([0, 0]);
  });

  it('uses WGS84 radii of curvature (series reference values for Vienna)', () => {
    const [, north] = plane.toLocal(16.3738, 48.2182); // 0.01° north
    const [east] = plane.toLocal(16.3838, 48.2082); // 0.01° east
    expect(north).toBeCloseTo(1111.94, 1);
    expect(east).toBeCloseTo(743.25, 1);
  });

  it('round-trips', () => {
    const [e, n] = plane.toLocal(16.39, 48.2);
    const [lon, lat] = plane.toGeo(e, n);
    expect(lon).toBeCloseTo(16.39, 10);
    expect(lat).toBeCloseTo(48.2, 10);
  });

  it('shrinks east distances towards the poles', () => {
    const north = new LocalTangentPlane({ lat: 60, lon: 0 });
    expect(north.toLocal(0.01, 60)[0]).toBeLessThan(plane.toLocal(16.3838, 48.2082)[0]);
  });
});

describe('scene axes', () => {
  it('maps east → x, up → y, north → −z', () => {
    expect(toScene([1, 2, 3])).toEqual([1, 3, -2]);
    expect(fromScene(1, 3, -2)).toEqual([1, 2, 3]);
  });
});
