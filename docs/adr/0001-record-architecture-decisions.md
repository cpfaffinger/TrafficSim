# ADR-0001: Record architecture decisions

- Status: Accepted
- Date: 2026-11-14

## Context

TrafficSim is a long-running, public project with several technology stacks (C#, Rust, TypeScript).
Decisions must stay understandable for contributors and AI coding agents joining later.

## Decision

We will record every architecturally significant decision as an ADR in `docs/adr`, numbered
sequentially, in English, using [`template.md`](template.md). ADRs are immutable once accepted;
changes happen through a new ADR that supersedes the old one.

## Consequences

- Reviewers can ask "which ADR covers this?" for structural changes.
- [`docs/constraints.md`](../constraints.md) summarises binding rules and links back to ADRs.

## Alternatives considered

- Wiki pages: drift away from the code, not versioned with it.
