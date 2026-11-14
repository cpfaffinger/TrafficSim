# ADR-0002: .NET 10 modular monolith backend

- Status: Accepted
- Date: 2026-11-14

## Context

The backend imports and compiles OSM data, mediates all external providers, persists scenarios
and results and serves the SPA. The team works in Rider; .NET has a mature geo stack
(NetTopologySuite, Npgsql with PostGIS support) and good test tooling.

## Decision

We will build the backend on **.NET 10 (LTS) / ASP.NET Core minimal APIs** as a **modular monolith**:

| Project | Responsibility |
|---------|----------------|
| `TrafficSim.Domain` | pure model: geo primitives, network, changesets (no I/O, no framework packages) |
| `TrafficSim.Application` | use cases, ports (interfaces) for providers and persistence |
| `TrafficSim.Providers` | provider adapters (anti-corruption layers) + shared fetch pipeline |
| `TrafficSim.Infrastructure` | PostGIS persistence, health checks |
| `TrafficSim.Api` | HTTP host: endpoints, OpenAPI, static SPA, composition root |

Dependency rule: `Api → Application → Domain`; `Providers` and `Infrastructure` implement
Application ports and are wired only in `Api`. Central package management
(`Directory.Packages.props`), nullable reference types and warnings-as-errors are enabled for all projects.

## Consequences

- One deployable, one process, one port; simple operations on a small staging host.
- Module boundaries are enforced by project references (architecture tests later).
- Splitting into services stays possible along the same boundaries if ever needed.

## Alternatives considered

- Node/TypeScript backend: shared types with the frontend, but weaker geo libraries.
- Microservices from day one: operational overhead without a scaling need.
