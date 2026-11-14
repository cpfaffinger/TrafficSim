# ADR-0003: PostgreSQL + PostGIS as spatial database

- Status: Accepted
- Date: 2026-11-14

## Context

We need a spatial database for imported networks, changesets, scenarios and aggregated results.
The initial wish was an "ArcGIS database engine in Postgres". An Esri enterprise geodatabase
requires ArcGIS Enterprise licences, which conflicts with the free-only constraint (C-04).

## Decision

We will use **PostgreSQL 17 with PostGIS 3.5** (`postgis/postgis` image). pgRouting may be added
for server-side routing analyses. Access from .NET via Npgsql + NetTopologySuite; schema migrations
with EF Core migrations (plain SQL migrations where EF is awkward).

## Consequences

- Open source, standard OGC types; ArcGIS Pro / QGIS can still connect to PostGIS as clients.
- Geometries in SRID 4326 with GiST indexes (see ADR-0011).
- Upgrading to PostgreSQL 18 later requires dump/restore or `pg_upgrade` (bind-mounted data dir).

## Alternatives considered

- ArcGIS Enterprise geodatabase: licence costs, proprietary.
- SpatiaLite / file-based storage: no concurrent server access, weaker tooling.
