# ADR-0013: Test-driven development and coverage targets

- Status: Accepted
- Date: 2026-11-14

## Context

The core value (lane compilation, traffic dynamics, provider translation) is logic-heavy and
error-prone. We want high confidence without chasing 100 % coverage for its own sake.

## Decision

| Area | Approach | Tooling | Line coverage target |
|------|----------|---------|----------------------|
| Backend Domain / Application | test-first unit tests | xUnit, coverlet | ≥ 85 % |
| Provider ACLs | fixture-based tests with a fake `HttpMessageHandler` | xUnit | ≥ 85 % |
| API | in-memory host tests (`WebApplicationFactory`) | xUnit | key endpoints |
| Persistence | integration tests against real PostGIS | Testcontainers (CI only) | key repositories |
| Sim core (Rust) | test-first unit, property-style and golden-run tests | `cargo test`, `cargo llvm-cov` | ≥ 85 % |
| Frontend logic | unit tests for non-rendering modules | Vitest + coverage-v8 | ≥ 70 % |
| Rendering / glue | smoke tests only | Vitest | not targeted |
| End-to-end | a few critical journeys (later phase) | Playwright | — |

Rules:

- Red → green → refactor for domain logic, compiler rules, model equations and ACL mappings.
- Tests never hit real external services (C-33). Optional live smoke tests are tagged and opt-in.
- Cross-stack contract tests share fixture files (network package, API payloads).
- Coverage thresholds are enforced per area in CI, excluding generated code and composition roots.

## Consequences

- Fast, deterministic suites; CI stays cheap (ADR-0015).
- Recorded provider fixtures must be refreshed when providers change their formats.

## Alternatives considered

- A global 100 % target: encourages low-value tests of glue and rendering code.
