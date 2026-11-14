import { parseBuiltins, type Builtins } from './builtins';

let cached: Promise<Builtins> | null = null;

/** Loads the sim-core WASM module on the main thread once and reads its built-in catalogues. */
export function loadBuiltins(): Promise<Builtins> {
  cached ??= import('../generated/sim-core/trafficsim_sim_core.js').then(async (wasm) => {
    await wasm.default();
    return parseBuiltins(wasm.builtinVehicleTypesJson(), wasm.builtinDriverProfilesJson(), wasm.builtinRoadClassProfilesJson());
  });
  cached.catch(() => {
    cached = null;
  });
  return cached;
}
