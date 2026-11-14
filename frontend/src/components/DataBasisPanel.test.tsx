// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DataBasisPanel, type ActivityAnalysis } from './DataBasisPanel';

afterEach(cleanup);

const analysis: ActivityAnalysis = {
  hasActivityData: true,
  features: { housing: 3, work: 2, retail: 1, education: 0, leisure: 0, freight: 0, parking: 1 },
  totals: { housing: 1200, work: 300, retail: 20, education: 0, leisure: 0, freight: 0, parking: 50 },
  housingUnitsPerKm2: 8000.4,
  carShare: 0.3,
  externalShare: 0.8,
  zones: 4,
  unattachedFeatures: 0,
};

describe('DataBasisPanel', () => {
  it('lists the available signals and assumptions', () => {
    render(<DataBasisPanel analysis={analysis} />);
    expect(screen.getByText('Dwellings')).toBeTruthy();
    expect(screen.getByText('≈ 1,200 units')).toBeTruthy();
    expect(screen.queryByText('Venues')).toBeNull();
    expect(screen.getByText(/car share 30 %/)).toBeTruthy();
  });

  it('explains the fallback without activity data', () => {
    render(<DataBasisPanel analysis={{ ...analysis, hasActivityData: false }} />);
    expect(screen.getByText(/road-class traffic profiles/)).toBeTruthy();
  });
});
