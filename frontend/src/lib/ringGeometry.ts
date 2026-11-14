/**
 * Maps a position along a circular road (metres, 0..length) to scene coordinates (ADR-0011:
 * x = east, z = -north, y = up). Vehicles drive counter-clockwise seen from above.
 */

export interface RingPose {
  x: number;
  z: number;
  /** Rotation around the y axis so that the vehicle's local +x axis points along the road. */
  heading: number;
}

export function ringRadius(length: number): number {
  return length / (2 * Math.PI);
}

export function ringPose(position: number, length: number): RingPose {
  const radius = ringRadius(length);
  const angle = (position / length) * 2 * Math.PI;
  return {
    x: radius * Math.cos(angle),
    z: -radius * Math.sin(angle),
    heading: angle + Math.PI / 2,
  };
}
