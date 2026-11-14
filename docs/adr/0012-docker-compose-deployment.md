# ADR-0012: Docker Compose deployment, bind mounts, single HTTP port, systemd on staging

- Status: Accepted
- Date: 2026-11-14

## Context

The application must be easy to self-host and must run on a shared staging server (`srv-dev1`,
4 CPU / 8 GB, many other stage containers, host nginx behind Cloudflare).

## Decision

- **One Compose project** (`compose.yaml` at the repository root) with the services `app`
  (ASP.NET Core serving SPA + WASM + API) and `db` (PostGIS). Optional services (self-hosted Photon,
  Overpass) are added later behind Compose **profiles**.
- **One published port:** `app` publishes `${TRAFFICSIM_BIND:-127.0.0.1}:${TRAFFICSIM_HTTP_PORT:-8080}`.
  The database is internal only.
- **Bind-mounted folders** under `./data` (`postgres/`, `cache/`, `osm/`). Named volumes only through the
  optional override `compose.volumes.yaml`.
- **Multi-stage Dockerfile:** Rust → WASM, Node → SPA, .NET publish, slim ASP.NET runtime as non-root user.
- **Staging:** repository checkout in `/opt/trafficsim` with `.env` and `data/` next to it (gitignored),
  managed by `/etc/systemd/system/trafficsim.service` (oneshot unit running `docker compose up -d`).
  Host nginx vhost `stagecompose00.pulseone.dev` → `127.0.0.1:28100` with the Cloudflare origin
  certificate. Deployment script: `deploy/staging/deploy.sh` (fetch → build → restart → readiness check).
- **Continuous deployment is pull-based:** `trafficsim-cd.timer` runs `cd-poll.sh` every minute;
  a new head of `main` with green CI check runs is built and rolled out automatically (see ADR-0015).
- The app sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
  so the simulation worker can use `SharedArrayBuffer`.

## Consequences

- Images are built on the staging host (no registry credentials needed). Publishing images to GHCR is
  possible later but kept manual (ADR-0015).
- PostgreSQL initialises its bind-mounted directory itself on Linux; on Windows hosts the named-volume
  override is recommended for the database.

## Alternatives considered

- Kubernetes: unnecessary for a single host.
- Named volumes by default: less transparent backups on the shared host.
