/**
 * Scenario-level pedestrian demand (ADR-0020): `pedestrians.demandFactor` of the sim config, kept in
 * the demand model's untouched keys (`rest`). Per-crossing values generated at import
 * (`pedestrians.crossings`) are carried through unchanged.
 */
import { isObject, type DemandModel } from './model';

/** Current factor (1 when unset). */
export function pedestrianFactor(model: DemandModel): number {
  const p = model.rest.pedestrians;
  const f = isObject(p) ? p.demandFactor : undefined;
  return typeof f === 'number' && Number.isFinite(f) && f >= 0 ? f : 1;
}

/** Sets the factor; invalid or negative input leaves the model unchanged. */
export function setPedestrianFactor(model: DemandModel, factor: number): DemandModel {
  if (!Number.isFinite(factor) || factor < 0) return model;
  const p = isObject(model.rest.pedestrians) ? model.rest.pedestrians : {};
  return { ...model, rest: { ...model.rest, pedestrians: { ...p, demandFactor: factor } } };
}
