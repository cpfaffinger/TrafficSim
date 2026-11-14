// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type GeocodeResult, type ImportJob, type NetworkSummary } from '../api/client';
import { bboxAreaKm2 } from '../lib/area';
import { readGoldenFixtureJson } from '../test/goldenFixture';
import { ImportPanel, type ViewerApi } from './ImportPanel';

afterEach(cleanup);

const place: GeocodeResult = {
  label: 'Karlsplatz, Vienna',
  latitude: 48.2,
  longitude: 16.37,
  category: 'square',
  bbox: null,
  osmReference: 'W1',
};

const recent: NetworkSummary = {
  id: 'b-old',
  bbox: [16.36, 48.19, 16.38, 48.21],
  createdAt: '2026-11-13T08:00:00Z',
  source: 'overpass',
  stats: { nodes: 10, links: 20, lanes: 30, connectors: 40, signals: 2 },
};

function fakeApi(overrides: Partial<ViewerApi> = {}): ViewerApi & Record<keyof ViewerApi, ReturnType<typeof vi.fn>> {
  const polls: ImportJob[] = [
    { jobId: 'j1', status: 'fetching', baselineId: null },
    { jobId: 'j1', status: 'completed', baselineId: 'b-new' },
  ];
  return {
    geocode: vi.fn().mockResolvedValue({ results: [place], provider: 'photon', attribution: 'Photon by Komoot · © OpenStreetMap' }),
    startImport: vi.fn().mockResolvedValue({ jobId: 'j1', status: 'queued', baselineId: null }),
    getImportJob: vi.fn().mockImplementation(() => Promise.resolve(polls.shift())),
    getPackage: vi.fn().mockResolvedValue(readGoldenFixtureJson()),
    listNetworks: vi.fn().mockResolvedValue([recent]),
    ...overrides,
  } as ViewerApi & Record<keyof ViewerApi, ReturnType<typeof vi.fn>>;
}

function setup(api = fakeApi()) {
  const props = { api, onArea: vi.fn(), onPackage: vi.fn(), onGeocoderAttribution: vi.fn() };
  render(<ImportPanel {...props} language="en" sleep={() => Promise.resolve()} />);
  return props;
}

async function searchAndPick() {
  fireEvent.change(screen.getByLabelText('Place, address or street'), { target: { value: 'Karlsplatz' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.click(await screen.findByRole('button', { name: /Karlsplatz, Vienna/ }));
}

describe('ImportPanel', () => {
  it('draws and imports a custom polygon (#110)', async () => {
    const api = fakeApi();
    let draw: ((p: readonly [number, number]) => void) | null = null;
    const onDraw = vi.fn((h: ((p: readonly [number, number]) => void) | null) => {
      draw = h;
    });
    const onArea = vi.fn();
    render(<ImportPanel api={api} onArea={onArea} onDraw={onDraw} onPackage={vi.fn()} onGeocoderAttribution={vi.fn()} language="en" sleep={() => Promise.resolve()} />);
    await searchAndPick();
    fireEvent.click(screen.getByText('Draw custom shape'));
    await waitFor(() => expect(draw).not.toBeNull());
    for (const p of [
      [16.36, 48.2],
      [16.38, 48.2],
      [16.37, 48.21],
    ] as const) {
      draw!(p);
      await waitFor(() => expect(onArea).toHaveBeenLastCalledWith(expect.arrayContaining([p]), expect.any(Boolean)));
    }
    // three corners close the outline automatically
    expect(onArea).toHaveBeenLastCalledWith(expect.any(Array), true);
    fireEvent.change(screen.getByLabelText('Name of the import'), { target: { value: 'Canal' } });
    fireEvent.click(screen.getByText('Import this area'));
    await waitFor(() => expect(api.startImport).toHaveBeenCalled());
    expect(api.startImport.mock.calls[0]![2]).toBe('Canal');
    expect(api.startImport.mock.calls[0]![0]).toEqual([
      [16.36, 48.2],
      [16.38, 48.2],
      [16.37, 48.21],
    ]);
  });


  it('searches, proposes a 1.5 km area and previews it', async () => {
    const props = setup();
    await searchAndPick();
    expect(props.api.geocode).toHaveBeenCalledWith('Karlsplatz', 6, expect.any(AbortSignal), 'en');
    expect(props.onGeocoderAttribution).toHaveBeenCalledWith('Photon by Komoot · © OpenStreetMap');
    expect(screen.getByText('Search: Photon by Komoot · © OpenStreetMap')).toBeTruthy();
    const bbox = props.onArea.mock.calls.at(-1)![0];
    expect(bboxAreaKm2(bbox)).toBeCloseTo(2.25, 3);
    expect(screen.getByText('2.25 km²')).toBeTruthy();
  });

  it('resizes the area', async () => {
    const props = setup();
    await searchAndPick();
    fireEvent.change(screen.getByLabelText('Width (km)'), { target: { value: '3' } });
    expect(bboxAreaKm2(props.onArea.mock.calls.at(-1)![0])).toBeCloseTo(4.5, 3);
    expect(screen.getByText('4.50 km²')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Height (km)'), { target: { value: '' } });
    expect(props.onArea).toHaveBeenCalledTimes(2); // invalid input is not committed
  });

  it('imports, polls and hands over the parsed package', async () => {
    const props = setup();
    await searchAndPick();
    fireEvent.click(screen.getByRole('button', { name: 'Import this area' }));
    await waitFor(() => expect(props.onPackage).toHaveBeenCalled());
    expect(props.api.startImport).toHaveBeenCalled();
    expect(props.api.getPackage).toHaveBeenCalledWith('b-new', expect.any(AbortSignal));
    expect(props.onPackage.mock.calls[0]![0].stats.links).toBe(10);
    expect(props.onArea).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole('button', { name: 'Import this area' })).toBeNull();
  });

  it('shows the size limit when the backend rejects the area', async () => {
    const api = fakeApi({ startImport: vi.fn().mockRejectedValue(new ApiError(422, 'The area must not exceed 25 km².')) });
    setup(api);
    await searchAndPick();
    fireEvent.click(screen.getByRole('button', { name: 'Import this area' }));
    expect(await screen.findByText('Import failed: The area must not exceed 25 km².')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import this area' })).toBeTruthy();
  });

  it('rejects invalid packages', async () => {
    const api = fakeApi({ getPackage: vi.fn().mockResolvedValue({ formatVersion: 9 }) });
    const props = setup(api);
    fireEvent.click(await screen.findByRole('button', { name: /20 links/ }));
    expect(await screen.findByText(/Import failed: formatVersion/)).toBeTruthy();
    expect(props.onPackage).not.toHaveBeenCalled();
  });

  it('loads a recent import without importing again', async () => {
    const props = setup();
    fireEvent.click(await screen.findByRole('button', { name: /20 links · 2 signals/ }));
    await waitFor(() => expect(props.onPackage).toHaveBeenCalled());
    expect(props.api.getPackage).toHaveBeenCalledWith('b-old', expect.any(AbortSignal));
    expect(props.api.startImport).not.toHaveBeenCalled();
  });

  it('can cancel the area and survives an unavailable recent list', async () => {
    const props = setup(fakeApi({ listNetworks: vi.fn().mockRejectedValue(new Error('404')) }));
    await searchAndPick();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onArea).toHaveBeenLastCalledWith(null);
    expect(screen.queryByLabelText('Recent imports')).toBeNull();
  });

  it('reports search errors and empty results', async () => {
    const api = fakeApi({ geocode: vi.fn().mockRejectedValueOnce(new Error('Geocoder down')).mockResolvedValueOnce({ results: [], provider: 'p', attribution: '' }) });
    setup(api);
    fireEvent.change(screen.getByLabelText('Place, address or street'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Search failed: Geocoder down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No places found.')).toBeTruthy();
  });
});
