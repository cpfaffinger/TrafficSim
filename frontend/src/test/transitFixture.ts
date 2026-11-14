// Test support: the cross-stack transit fixture (#85), read with fs like the golden fixture (tests run from frontend/).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseNetworkPackage } from '../network/parse';
import type { NetworkPackage } from '../network/types';

export function readTransitFixtureJson(): Record<string, unknown> {
  const file = path.resolve(process.cwd(), '../docs/architecture/fixtures/network-package-transit-v1.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export function loadTransitFixture(): NetworkPackage {
  return parseNetworkPackage(readTransitFixtureJson());
}
