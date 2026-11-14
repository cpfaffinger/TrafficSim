// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_BUILTINS } from '../demand/builtins';
import { DemandEditor } from '../demand/DemandEditor';
import { fixturePackage } from '../test/demandFixtures';
import { loadTransitFixture } from '../test/transitFixture';

afterEach(cleanup);

const scenario = (demand: unknown) => ({ id: 's1', name: 'Buses', demand, durationSeconds: 3600 });

describe('Transit tab of the demand editor (#85)', () => {
  it('lists the lines and writes headways and dwell times to the transit config', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DemandEditor
        scenario={scenario({ transit: { vehicleType: 'bus' } })}
        pkg={loadTransitFixture()}
        builtins={FALLBACK_BUILTINS}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: /Transit/ }));
    const table = screen.getByRole('table', { name: 'Bus lines' });
    expect(table.textContent).toContain('13A');
    expect(table.textContent).toContain('5 min');
    fireEvent.change(screen.getByLabelText('Headway of line 13A (t0)'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Dwell time'), { target: { value: '25' } });
    expect(table.textContent).toContain('4 min');
    fireEvent.click(screen.getByRole('button', { name: 'Save demand' }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect((onSave.mock.calls[0]![0] as Record<string, unknown>).transit).toEqual({ vehicleType: 'bus', headways: { t0: 240 }, dwellTime: 25 });
  });

  it('flags invalid values and turns lines off', () => {
    render(<DemandEditor scenario={scenario({})} pkg={loadTransitFixture()} builtins={FALLBACK_BUILTINS} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Transit/ }));
    fireEvent.change(screen.getByLabelText('Headway of line 13A (t0)'), { target: { value: '0' } });
    expect(screen.getByRole('table', { name: 'Bus lines' }).textContent).toContain('off');
    fireEvent.change(screen.getByLabelText('Headway factor'), { target: { value: '0' } });
    expect(screen.getByLabelText('Problems').textContent).toContain('headway factor');
    expect((screen.getByRole('button', { name: 'Save demand' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is hidden for networks without lines', () => {
    render(<DemandEditor scenario={scenario({})} pkg={fixturePackage()} builtins={FALLBACK_BUILTINS} onClose={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: /Transit/ })).toBeNull();
  });
});
