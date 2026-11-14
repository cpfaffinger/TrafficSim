# ADR-0015: Lean, cost-free CI on GitHub Actions

- Status: Accepted
- Date: 2026-11-14

## Context

The repository is public. Standard GitHub-hosted runners are free for public repositories; larger
runners are billed. The project must not cause CI costs (C-34).

## Decision

- Use **only standard runners** (`ubuntu-latest`). No larger runners, no macOS/Windows runners.
- **One workflow** (`ci.yml`) with one job per area (backend, sim-core, frontend), each gated by a
  **path filter** (on `main` diffed against the last commit with green CI, so failed changes are
  re-tested until green), plus a Docker build check that only runs when build-relevant files change on `main`.
- `concurrency` cancels superseded PR runs (never runs on `main`, so no commit stays untested); dependency caching (NuGet, cargo, npm).
- **No scheduled workflows**, no OS/version matrices.
- **Deployment costs no Actions minutes and needs no secrets in GitHub**: continuous deployment is
  *pull-based*. A systemd timer on the staging host polls `main` (`git ls-remote`) every minute and
  deploys the head commit once all of its CI check runs are green (`deploy/staging/cd-poll.sh`).
  Failed commits are marked and never retried automatically. Manual deploys run `deploy.sh` on the host.
- Dependabot: monthly, grouped updates only.

## Consequences

- Near-zero CI cost and noise; slightly slower feedback for cross-cutting changes.

## Alternatives considered

- Self-hosted runner on srv-dev1: free compute, but a security risk for a public repository (fork PRs).
