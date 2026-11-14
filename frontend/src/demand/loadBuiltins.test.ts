import { describe, expect, it, vi } from 'vitest';

const init = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
vi.mock('../generated/sim-core/trafficsim_sim_core.js', () => ({
  default: init,
  builtinVehicleTypesJson: () => '{"car":{},"van":{}}',
  builtinDriverProfilesJson: () => '{"average":{}}',
  builtinRoadClassProfilesJson: () => '{"motorway":{"volumePerLane":1400,"curve":"weekday"}}',
}));

describe('loadBuiltins', () => {
  it('initialises the WASM module once and retries after a failure', async () => {
    const { loadBuiltins } = await import('./loadBuiltins');
    await expect(loadBuiltins()).rejects.toThrow('offline');
    const b = await loadBuiltins();
    expect(b.vehicleTypes).toEqual(['car', 'van']);
    expect(b.roadClassProfiles.motorway).toEqual({ volumePerLane: 1400, curve: 'weekday' });
    expect(await loadBuiltins()).toBe(b);
    expect(init).toHaveBeenCalledTimes(2);
  });
});
