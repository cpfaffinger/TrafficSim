import { describe, expect, it } from 'vitest';
import { mergeAttributions, OSM_ATTRIBUTION } from './attribution';
import { nextPick, uniqueOwners } from './picking';

describe('picking', () => {
  it('orders owners by distance and drops duplicates and non-pickables', () => {
    expect(
      uniqueOwners([
        { owner: 3, distance: 9 },
        { owner: 1, distance: 2 },
        { owner: -1, distance: 1 },
        { owner: 1, distance: 3 },
      ]),
    ).toEqual([1, 3]);
  });

  it('selects the nearest hit and cycles through levels on repeated clicks', () => {
    const owners = [5, 8, 2]; // bridge deck, bridge lane, street below
    expect(nextPick(owners, { x: 10, y: 10 }, null)).toBe(5);
    expect(nextPick(owners, { x: 11, y: 10 }, { x: 10, y: 10, owner: 5 })).toBe(8);
    expect(nextPick(owners, { x: 11, y: 10 }, { x: 10, y: 10, owner: 2 })).toBe(5);
    expect(nextPick(owners, { x: 100, y: 10 }, { x: 10, y: 10, owner: 5 })).toBe(5);
    expect(nextPick(owners, { x: 10, y: 10 }, { x: 10, y: 10, owner: 99 })).toBe(5);
    expect(nextPick([], { x: 0, y: 0 }, null)).toBeNull();
  });
});

describe('attribution', () => {
  it('merges, trims and deduplicates', () => {
    expect(
      mergeAttributions(['© OpenStreetMap contributors (ODbL)'], ['  © openstreetmap   contributors (ODbL) ', 'Photon by Komoot', ''], null, ['OpenFreeMap © OpenMapTiles']),
    ).toEqual(['© OpenStreetMap contributors (ODbL)', 'Photon by Komoot', 'OpenFreeMap © OpenMapTiles']);
  });

  it('always shows the OSM notice', () => {
    expect(mergeAttributions()).toEqual([OSM_ATTRIBUTION]);
  });
});
