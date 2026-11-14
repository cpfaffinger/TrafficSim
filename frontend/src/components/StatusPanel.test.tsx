// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDuration, StatusPanel } from './StatusPanel';

afterEach(cleanup);

describe('StatusPanel', () => {
  it('shows backend state, version and simulation figures', () => {
    render(<StatusPanel status="ok" version="0.1.0" simTime={125.4} meanSpeed={5} vehicleCount={22} />);

    expect(screen.getByText('online')).toBeTruthy();
    expect(screen.getByText('0.1.0')).toBeTruthy();
    expect(screen.getByText('2:05')).toBeTruthy();
    expect(screen.getByText('22')).toBeTruthy();
    expect(screen.getByText('18.0 km/h')).toBeTruthy();
  });

  it('renders placeholders while loading', () => {
    render(<StatusPanel status="unknown" version={null} simTime={0} meanSpeed={0} vehicleCount={0} />);

    expect(screen.getByText('checking…')).toBeTruthy();
    expect(screen.getByText('–')).toBeTruthy();
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [59.9, '0:59'],
    [61, '1:01'],
    [-5, '0:00'],
  ])('formats %d s as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
