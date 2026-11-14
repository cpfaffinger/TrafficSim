# data/

Bind-mounted runtime data (gitignored, see [ADR-0012](../docs/adr/0012-docker-compose-deployment.md)).

| Folder | Content |
|--------|---------|
| `postgres/` | PostgreSQL/PostGIS data directory |
| `cache/` | provider response cache |
| `osm/` | optional Geofabrik `.osm.pbf` extracts for large imports |
