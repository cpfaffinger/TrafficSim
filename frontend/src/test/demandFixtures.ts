import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseNetworkPackage } from '../network/parse';
import type { NetworkPackage } from '../network/types';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.resolve(process.cwd(), '../docs/architecture/fixtures', name), 'utf8')) as unknown;

/** Generated scenario demand per scenario key (docs/architecture/fixtures/generated-demand-v1.json). */
export const generatedDemand = (key = 'morning'): Record<string, unknown> =>
  (fixture('generated-demand-v1.json') as Record<string, Record<string, unknown>>)[key]!;

/** The reference network: signal n0, boundary nodes n1–n8, primary/residential/motorway links. */
export const fixturePackage = (): NetworkPackage => parseNetworkPackage(fixture('network-package-v1.json'));
