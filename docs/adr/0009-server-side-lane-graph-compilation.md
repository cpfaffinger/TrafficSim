# ADR-0009: Server-side lane graph compilation and versioned network package

- Status: Accepted
- Date: 2026-11-14

## Context

OSM describes roads as ways with tags, not as lanes. The simulator needs an explicit lane graph:
lanes, lane connectors at junctions, conflict zones and signals. Compilation is complex, data-heavy and
must be consistent for all clients.

## Decision

- The backend compiles OSM elements into a **lane graph** (`TrafficSim.Domain` network model) and stores
  the result in PostGIS as a `NetworkBaseline`.
- Clients receive a **network package**: a versioned, self-contained document (`formatVersion`, origin,
  nodes, links, lanes with polylines in local metres, connectors, junction controls, signals,
  assumptions). JSON first (compressed); a binary encoding may follow behind the same version field.
- The package schema is the contract between .NET, TypeScript and Rust. It is documented in
  `docs/architecture/network-package.md` and covered by contract tests on all three sides using shared
  fixture files.

## Consequences

- One implementation of OSM interpretation; the Rust core stays small (no OSM parsing).
- Changesets (ADR-0010) are applied to the compiled model on the server, with a client-side preview.

## Alternatives considered

- Compiling in the browser (Rust): duplicated logic for persistence and validation, larger downloads.
