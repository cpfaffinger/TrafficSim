# ADR-0015: Lean, cost-free CI on GitHub Actions

- Status: Accepted
- Date: 2026-11-14

## Context

The repository is public. Standard GitHub-hosted runners are free for public repositories; larger
runners are billed. The project must not cause CI costs (C-34).

## Decision

- Use **only standard runners** (`ubuntu-latest`). No larger runners, no macOS/Windows runners.
- **One workflow** (`ci.yml`) with one job per area (backend, sim-core, frontend), each gated by a
  **path filter**, plus a Docker build check that only runs when build-relevant files change on `main`.
- `concurrency` with `cancel-in-progress: true` per ref; dependency caching (NuGet, cargo, npm).
- **No scheduled workflows**, no OS/version matrices.
- **Deployment is manual**: `deploy/staging/deploy.sh` from a developer machine via SSH. A
  `workflow_dispatch` deploy may be added later — never on every push.
- Dependabot: monthly, grouped updates only.

## Consequences

- Near-zero CI cost and noise; slightly slower feedback for cross-cutting changes.

## Alternatives considered

- Self-hosted runner on srv-dev1: free compute, but a security risk for a public repository (fork PRs).
