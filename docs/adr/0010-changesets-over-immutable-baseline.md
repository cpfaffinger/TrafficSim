# ADR-0010: Network edits as changesets over an immutable baseline

- Status: Accepted
- Date: 2026-11-14

## Context

Users modify the network (add lanes, change turn lanes, retime signals, add roads) and want to compare
variants against the original. Re-importing OSM must not destroy edits.

## Decision

- A `NetworkBaseline` is immutable once compiled.
- A scenario references a baseline plus an ordered `Changeset` of typed, validated edit commands
  (`AddLane`, `RemoveLane`, `SetTurnLanes`, `SetSpeedLimit`, `AddLink`, `SetSignalPlan`, …).
- The effective network is `apply(baseline, changeset)`; the same mechanism powers undo/redo and A/B
  comparison. Edits reference stable element ids of the baseline.
- When rebasing onto a newer baseline, edits whose targets vanished are reported, never dropped silently.

## Consequences

- Edits are small, auditable and serialisable; variants are cheap.
- Edit commands need validation rules and tests (domain level, test-first).

## Alternatives considered

- Mutating the stored network: loses provenance, makes comparisons and rebasing hard.
- Writing edits back to OSM: out of scope and inappropriate for hypothetical changes.
