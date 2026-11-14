import { describe, expect, it } from 'vitest';
import { ringPose, ringRadius } from './ringGeometry';

describe('ringGeometry', () => {
  it('derives the radius from the circumference', () => {
    expect(ringRadius(2 * Math.PI * 50)).toBeCloseTo(50);
  });

  it('places position 0 east of the centre and a quarter lap north', () => {
    const length = 200;
    const start = ringPose(0, length);
    const quarter = ringPose(50, length);

    expect(start.x).toBeCloseTo(ringRadius(length));
    expect(start.z).toBeCloseTo(0);
    expect(quarter.x).toBeCloseTo(0);
    expect(quarter.z).toBeCloseTo(-ringRadius(length)); // north = -z
  });

  it('points the heading along the direction of travel', () => {
    const pose = ringPose(0, 100);
    // Tangent at angle 0 for counter-clockwise travel points north (-z): heading = 90°.
    expect(pose.heading).toBeCloseTo(Math.PI / 2);
  });
});
