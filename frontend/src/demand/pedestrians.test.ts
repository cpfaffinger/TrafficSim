import { describe, expect, it } from 'vitest';
import { parseDemand, serializeDemand } from './model';
import { pedestrianFactor, setPedestrianFactor } from './pedestrians';

describe('scenario pedestrian demand', () => {
  it('reads and writes pedestrians.demandFactor and keeps per-crossing values', () => {
    const model = parseDemand({ startTimeOfDay: 0, pedestrians: { demandFactor: 0.15, crossings: { x0: 230 } } });
    expect(pedestrianFactor(model)).toBe(0.15);
    const next = setPedestrianFactor(model, 2);
    expect(serializeDemand(next).pedestrians).toEqual({ demandFactor: 2, crossings: { x0: 230 } });
  });

  it('defaults to 1 and ignores invalid input', () => {
    const model = parseDemand({ startTimeOfDay: 0 });
    expect(pedestrianFactor(model)).toBe(1);
    expect(setPedestrianFactor(model, -1)).toBe(model);
    expect(setPedestrianFactor(model, Number.NaN)).toBe(model);
    expect(serializeDemand(setPedestrianFactor(model, 0)).pedestrians).toEqual({ demandFactor: 0 });
    expect(pedestrianFactor(parseDemand({ pedestrians: { demandFactor: 'x' } }))).toBe(1);
  });
});
