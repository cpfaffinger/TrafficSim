// Test support: loads the cross-stack golden fixture from docs/ at runtime. It is read with fs (not
// imported) because the Docker build only copies frontend/ and tsc must not resolve files outside src.
import fs from 'node:fs';
import { parseNetworkPackage } from '../network/parse';
import type { NetworkPackage } from '../network/types';

const FIXTURE_URL = new URL('../../../docs/architecture/fixtures/network-package-v1.json', import.meta.url);

export function readGoldenFixtureJson(): unknown {
  return JSON.parse(fs.readFileSync(FIXTURE_URL, 'utf8')) as unknown;
}

export function loadGoldenFixture(): NetworkPackage {
  return parseNetworkPackage(readGoldenFixtureJson());
}
