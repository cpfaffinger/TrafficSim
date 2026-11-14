// Builds the Rust simulation core to WebAssembly and generates JS bindings into
// src/generated/sim-core. Requires: rustup target wasm32-unknown-unknown and
// wasm-bindgen-cli matching the version pinned in sim-core/Cargo.toml.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const crateDir = path.resolve(here, '../../sim-core');
const outDir = path.resolve(here, '../src/generated/sim-core');
const wasm = path.join(crateDir, 'target/wasm32-unknown-unknown/release/trafficsim_sim_core.wasm');

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('cargo', ['build', '--release', '--lib', '--target', 'wasm32-unknown-unknown'], crateDir);
run('wasm-bindgen', ['--target', 'web', '--out-dir', outDir, wasm], crateDir);
console.log(`WASM bindings written to ${outDir}`);
