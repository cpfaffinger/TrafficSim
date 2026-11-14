# ADR-0010: Network edits as changesets over an immutable baseline

- Status: Accepted
- Date: 2026-11-14

## Context

Users modify the network (add lanes, change turn lanes, retime signals, add roads) and want to compare
variants against the original. Re-importing OSM must not destroy edits.

## Decision

- A `NetworkBaseline` is immutable once compiled.
- A scenario references a baseline plus an ordered `Changeset` of typed, validated edit commands.
- **Edits act on the baseline's raw OSM data**, which is stored with the baseline, and the result is
  compiled again (ADR-0009). This keeps one interpretation of road semantics: "add a lane", "set turn
  lanes", "speed limit", "bus lane", "solid line", "bridge" are tag changes on a way
  (`set_way_tags`, optionally on the part between two nodes — the way is split there), junction
  control is a node tag change (`set_node_tags`), new roads are new ways/nodes with client-chosen
  negative ids (`add_way`, `insert_node`), plus `remove_way` and `convert_to_roundabout`.
- Edits that the OSM model cannot express are **lane-graph overrides** applied by the compiler:
  lane connections and turn bans per movement, and signal plans. Movements are keyed by OSM node id
  plus the neighbouring OSM nodes on the incoming and outgoing way, which stay stable across
  recompilations (compiled `n…`/`l…`/`c…` ids do not).
- The effective network is `compile(apply(baselineOsm, changeset))`; compiled packages are cached by
  `(baseline, changeset hash)`. The same mechanism powers undo/redo (the client edits the list) and
  A/B comparison.
- When rebasing onto a newer baseline, edits whose targets vanished are reported, never dropped silently.

## Consequences

- JSON encoding: `{"op":"set_way_tags","wayId":…,"fromNode":…,"toNode":…,"tags":{"lanes":"3"}}` etc.
  (see `TrafficSim.Domain.Editing.EditOperation`). API: `/api/v1/scenarios`, preview via
  `POST /api/v1/networks/{id}/preview`.

- Edits are small, auditable and serialisable; variants are cheap.
- Edit commands need validation rules and tests (domain level, test-first).

## Alternatives considered

- Mutating the stored network: loses provenance, makes comparisons and rebasing hard.
- Writing edits back to OSM: out of scope and inappropriate for hypothetical changes.
