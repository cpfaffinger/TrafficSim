// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixturePackage, generatedDemand } from '../test/demandFixtures';
import { FALLBACK_BUILTINS } from './builtins';
import { DemandEditor, type DemandEditorProps } from './DemandEditor';

afterEach(cleanup);

const pkg = fixturePackage();
const scenario = (demand: unknown = generatedDemand('morning')) => ({ id: 's1', name: 'Morning', demand, durationSeconds: 3 * 3600 });

function setup(over: Partial<DemandEditorProps> = {}) {
  const props: DemandEditorProps = {
    scenario: scenario(),
    pkg,
    builtins: FALLBACK_BUILTINS,
    onSave: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    onHighlight: vi.fn(),
    confirm: vi.fn().mockReturnValue(true),
    ...over,
  };
  const view = render(<DemandEditor {...props} />);
  return { props, view };
}

const tab = (name: RegExp) => fireEvent.click(screen.getByRole('tab', { name }));
const saveButton = () => screen.getByRole('button', { name: 'Save demand' }) as HTMLButtonElement;
const lastSaved = (props: DemandEditorProps) => (props.onSave as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as Record<string, unknown>;

describe('DemandEditor overview (#54)', () => {
  it('shows the window and totals per process kind, and edits the start time', async () => {
    const { props } = setup();
    expect(screen.getByText('(06:30–09:30)')).toBeTruthy();
    const rows = screen.getAllByRole('row').map((r) => r.textContent);
    expect(rows.some((r) => r?.startsWith('Boundary entries6'))).toBe(true);
    expect(rows.some((r) => r?.startsWith('OD matrix13'))).toBe(true);
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '07:15' } });
    expect(screen.getByText('(unsaved)')).toBeTruthy();
    fireEvent.click(saveButton());
    await screen.findByText('Demand saved.');
    expect(lastSaved(props).startTimeOfDay).toBe(26100);
    expect(screen.queryByText('(unsaved)')).toBeNull();
  });

  it('blocks saving invalid demand and lists the problems', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '' } });
    expect(saveButton().disabled).toBe(true);
    expect(within(screen.getByRole('list', { name: 'Problems' })).getByText(/Start time/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Overview/ }).textContent).toContain('1');
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    expect(screen.queryByRole('list', { name: 'Problems' })).toBeNull();
  });

  it('toggles road-class through traffic', async () => {
    const { props } = setup();
    fireEvent.click(screen.getByLabelText(/Road-class traffic/));
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(lastSaved(props).autoEntries).toBe(false);
  });

  it('reports save errors', async () => {
    setup({ onSave: vi.fn().mockRejectedValue(new Error('boom')) });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '08:00' } });
    fireEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toBe('boom');
  });

  it('asks before closing with unsaved changes', () => {
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { props } = setup({ confirm });
    fireEvent.click(screen.getByRole('button', { name: 'Close demand editor' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '08:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close demand editor' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close demand editor' }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('adopts demand saved elsewhere', () => {
    const { props, view } = setup();
    view.rerender(<DemandEditor {...props} scenario={scenario({ ...generatedDemand('morning'), startTimeOfDay: 3600 })} />);
    expect(screen.getByText('(01:00–04:00)')).toBeTruthy();
    expect(screen.queryByText('(unsaved)')).toBeNull();
  });
});

describe('DemandEditor OD matrix', () => {
  it('filters, sorts, edits, adds and removes entries and highlights the selected pair', async () => {
    const { props } = setup();
    tab(/OD matrix/);
    expect(screen.getByText(/13 of 13 entries/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter OD entries'), { target: { value: 'flat' } });
    expect(screen.getByText(/4 of 13 entries/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter OD entries'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'z0_0' } });
    expect(props.onHighlight).toHaveBeenLastCalledWith({ zone: 'z0_0', from: null, to: null, nodes: [] });
    fireEvent.change(screen.getByLabelText('Zone'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: /veh\/h/ }));
    expect(screen.getByRole('columnheader', { name: /veh\/h/ }).getAttribute('aria-sort')).toBe('descending');
    const first = screen.getAllByLabelText(/^Vehicles per hour of entry/)[0] as HTMLInputElement;
    expect(first.value).toBe('15.96');

    fireEvent.change(screen.getByLabelText('Vehicles per hour of entry 1'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText('Curve of entry 1'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Destination of entry 1'), { target: { value: 'z0_0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Details of entry 1' }));
    expect(props.onHighlight).toHaveBeenLastCalledWith({ zone: null, from: 'z-1_-1', to: 'z0_0', nodes: [] });
    expect(screen.getByRole('img', { name: /Curve constant/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove entry 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add OD entry' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    const od = lastSaved(props).od as Record<string, unknown>[];
    expect(od).toHaveLength(13);
    expect(od[0]).toEqual({ from: 'z-1_-1', to: 'z0_0', vph: 12.5, driverMix: expect.any(Object) });
    expect(od.at(-1)).toEqual({ from: 'z-1_-1', to: 'z-1_0', vph: 0, curve: 'flat' });
  });

  it('edits per-pair mixes in the details row', async () => {
    const { props } = setup();
    tab(/OD matrix/);
    fireEvent.click(screen.getByRole('button', { name: 'Details of entry 1' }));
    const vehicle = screen.getByRole('group', { name: 'Vehicle mix of this pair' });
    fireEvent.click(within(vehicle).getByRole('checkbox'));
    fireEvent.change(within(vehicle).getByLabelText('truck share (%)'), { target: { value: '50' } });
    const driver = screen.getByRole('group', { name: 'Driver mix of this pair' });
    fireEvent.click(within(driver).getByRole('checkbox'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    const od0 = (lastSaved(props).od as Record<string, unknown>[])[0]!;
    expect((od0.vehicleMix as Record<string, number>).truck).toBe(0.5);
    expect(od0).not.toHaveProperty('driverMix');
  });

  it('selects the zone of a road picked on the map, cycling through overlapping zones', () => {
    const { props, view } = setup();
    view.rerender(<DemandEditor {...props} picked={{ linkId: 'l2', nodeIds: ['n0', 'n2'] }} />);
    expect((screen.getByLabelText('Zone') as HTMLSelectElement).value).toBe('z0_-1');
    view.rerender(<DemandEditor {...props} picked={{ linkId: 'l2', nodeIds: ['n0', 'n2'], again: 1 } as never} />);
    expect((screen.getByLabelText('Zone') as HTMLSelectElement).value).toBe('z0_0');
    view.rerender(<DemandEditor {...props} picked={{ nodeIds: ['n0'] }} />);
    expect((screen.getByLabelText('Zone') as HTMLSelectElement).value).toBe('z0_0');
  });

  it('flags OD entries with unknown zones', () => {
    setup({ scenario: scenario({ zones: [{ id: 'a', links: ['l1'] }], od: [{ from: 'a', to: 'gone', vph: 1 }] }) });
    tab(/OD matrix/);
    expect((screen.getByLabelText('Destination of entry 1') as HTMLSelectElement).value).toBe('gone');
    expect(screen.getByText('OD entry 1: unknown zone “gone”.')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /OD matrix/ }).textContent).toContain('1');
  });
});

describe('DemandEditor entries', () => {
  it('overrides an entry node and patches road-class profiles', async () => {
    const { props, view } = setup();
    tab(/Entries/);
    const n1 = screen.getByRole('row', { name: /^n1/ });
    expect(n1.textContent).toContain('primary ×2');
    expect(n1.textContent).toContain('1,200');
    fireEvent.click(within(n1).getByLabelText('Override demand of n1'));
    fireEvent.change(screen.getByLabelText('Vehicles per hour at n1'), { target: { value: '450' } });
    fireEvent.change(screen.getByLabelText('Curve at n1'), { target: { value: 'flat' } });
    fireEvent.change(screen.getByLabelText('Volume per lane of motorway'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Curve of residential'), { target: { value: 'freight' } });
    fireEvent.click(screen.getByRole('row', { name: /^n3/ }));
    expect(props.onHighlight).toHaveBeenLastCalledWith({ zone: null, from: null, to: null, nodes: ['n3'] });
    view.rerender(<DemandEditor {...props} picked={{ nodeIds: ['n5'] }} />);
    expect(screen.getByRole('row', { name: /^n5/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    const saved = lastSaved(props);
    expect(saved.entries).toEqual({ n1: { vph: 450, curve: 'flat' } });
    expect(saved.profiles).toEqual({ motorway: { volumePerLane: 1000 }, residential: { curve: 'freight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset profiles to built-in defaults' }));
    fireEvent.click(screen.getByLabelText('Override demand of n1'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(2));
    expect(lastSaved(props)).not.toHaveProperty('profiles');
  });

  it('shows forced curves and stale overrides', () => {
    setup({ scenario: scenario({ demandCurve: 'flat', entries: { n6: 10 } }) });
    tab(/Entries/);
    expect(screen.getByText(/forces curve/)).toBeTruthy();
    expect(screen.getByText('not an entry node')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove override' }));
    expect(screen.queryByText('not an entry node')).toBeNull();
  });

  it('works without a network package', () => {
    setup({ pkg: null, scenario: scenario({}) });
    tab(/Entries/);
    expect(screen.getByText('No boundary entries in this network.')).toBeTruthy();
  });
});

describe('DemandEditor curves and mixes', () => {
  it('charts curves and creates, edits, renames and deletes a custom curve', async () => {
    const { props } = setup();
    tab(/Curves/);
    expect(screen.getByRole('img', { name: 'Curve weekday: hourly factors, peak 1.00 at 17:00' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /New custom curve/ }));
    expect(screen.getAllByLabelText(/^Factor /)).toHaveLength(24);
    fireEvent.change(screen.getByLabelText('Factor 07:00'), { target: { value: '2' } });
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'weekday' } });
    expect(screen.getByText('This name is taken.')).toBeTruthy();
    fireEvent.change(name, { target: { value: 'school' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect((screen.getByLabelText('Curve') as HTMLSelectElement).value).toBe('school');
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    const curves = lastSaved(props).curves as Record<string, { interval: number; factors: number[] }>;
    expect(curves.school!.factors[7]).toBe(2);
    expect(curves.school!.interval).toBe(3600);
    fireEvent.click(screen.getByRole('button', { name: 'Delete curve' }));
    expect((screen.getByLabelText('Curve') as HTMLSelectElement).value).toBe('weekday');
  });

  it('converts non-hourly custom curves and keeps used curves', () => {
    setup({ scenario: scenario({ curves: { q: { interval: 900, factors: [1, 0] } }, od: [], zones: [], entries: { n1: { vph: 1, curve: 'q' } } }) });
    tab(/Curves/);
    expect(screen.getByText(/2 factors every 900 s/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Delete curve' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Convert to 24 hourly factors' }));
    expect((screen.getByLabelText('Factor 00:00') as HTMLInputElement).value).toBe('0.5');
  });

  it('edits the scenario vehicle and driver mixes with linked sliders', async () => {
    const { props } = setup({ scenario: scenario({ vehicleMix: { car: 1 } }) });
    tab(/Mixes/);
    const vehicle = screen.getByRole('group', { name: 'Vehicle mix' });
    fireEvent.change(within(vehicle).getByLabelText('car'), { target: { value: '80' } });
    const driver = screen.getByRole('group', { name: 'Driver mix' });
    expect(within(driver).getByText(/legacy average drivers/)).toBeTruthy();
    fireEvent.click(within(driver).getByRole('checkbox'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    const saved = lastSaved(props);
    expect((saved.vehicleMix as Record<string, number>).car).toBe(0.8);
    expect(Object.values(saved.vehicleMix as Record<string, number>).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(saved.driverMix).toMatchObject({ average: 0.5 });
  });

  it('is read-only in the shared view', () => {
    setup({ readOnly: true, onSave: undefined });
    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save demand' })).toBeNull();
    expect((screen.getByLabelText('Start time') as HTMLInputElement).disabled).toBe(true);
    tab(/OD matrix/);
    expect((screen.getByLabelText('Vehicles per hour of entry 1') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add OD entry' })).toBeNull();
    tab(/Curves/);
    expect(screen.queryByRole('button', { name: /New custom curve/ })).toBeNull();
    tab(/Mixes/);
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).disabled).toBe(true);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Close demand editor' })));
  });
});
