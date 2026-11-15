# Staging deployment (srv-dev1 → stagecompose00.pulseone.dev)

Continuous deployment is **pull-based** (ADR-0012, ADR-0015): no SSH keys or secrets live in
GitHub. A systemd timer on the host polls `main` every minute; when the head commit's CI checks
are green it builds the image on the host and restarts the stack.

```
GitHub push ─▶ CI (Actions) ─▶ check runs green
                                     ▲
srv-dev1: trafficsim-cd.timer (60 s) ─┘─▶ deploy.sh <sha> ─▶ docker compose build + up ─▶ /readyz
```

| File | Purpose |
|------|---------|
| `install.sh` | one-time bootstrap: clone to `/opt/trafficsim`, `.env`, systemd units, nginx vhost |
| `deploy.sh [sha]` | build and roll out a commit (default `origin/main`); marks failures to avoid loops; removes stored imports when the import pipeline changed |
| `cd-poll.sh` | timer job: new commit + green CI ⇒ `deploy.sh` |
| `trafficsim.service` | starts/stops the Compose project at boot |
| `trafficsim-cd.service` / `.timer` | runs `cd-poll.sh` every minute |
| `nginx/stagecompose00.pulseone.dev.conf` | host nginx vhost (Cloudflare origin certificate) → `127.0.0.1:28100` |

## Operations

```bash
systemctl status trafficsim trafficsim-cd.timer
journalctl -u trafficsim-cd -f            # deployment log
/opt/trafficsim/deploy/staging/deploy.sh  # manual deploy of origin/main
rm /opt/trafficsim/.deploy/failed         # retry a commit whose deploy failed
docker compose -f /opt/trafficsim/compose.yaml logs -f app
```

Rules: a commit is deployed only when **all** its check runs are `success`/`skipped`/`neutral`.
Commits without any check run (e.g. `[skip ci]`) are not auto-deployed — run `deploy.sh` manually.

Stored imports are compiled once and never recompiled. `deploy.sh` fingerprints the code that shapes
a network package (`TrafficSim.Domain`, `TrafficSim.Providers`, `TrafficSim.Application/Networks`)
in `.deploy/compiler`; when a deploy changes it, every import is deleted through the API (with its
scenarios and runs) so nobody simulates a network built by an old compiler. Import the area again
afterwards. Deploys that only change the UI, the sim core or other backend code keep the imports.
