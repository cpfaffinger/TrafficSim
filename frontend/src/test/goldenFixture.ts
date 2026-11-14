// Test support: loads the cross-stack golden fixture from docs/ at runtime. It is read with fs (not
// imported) because the Docker build only copies frontend/ and tsc must not resolve files outside src.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNetworkPackage } from '../network/parse';
import type { NetworkPackage } from '../network/types';

const RELATIVE = '../../../docs/architecture/fixtures/network-package-v1.json';

function fixturePath(): string {
  const here = new URL(RELATIVE, import.meta.url);
  if (here.protocol === 'file:') return fileURLToPath(here);
  // Under the jsdom environment import.meta.url is not a file URL; tests run from frontend/.
  return path.resolve(process.cwd(), '../docs/architecture/fixtures/network-package-v1.json');
}

export function readGoldenFixtureJson(): unknown {
  return JSON.parse(fs.readFileSync(fixturePath(), 'utf8')) as unknown;
}

export function loadGoldenFixture(): NetworkPackage {
  return parseNetworkPackage(readGoldenFixtureJson());
}
