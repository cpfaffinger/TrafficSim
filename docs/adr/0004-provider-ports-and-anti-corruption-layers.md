# ADR-0004: Provider ports, anti-corruption layers and a shared fetch pipeline

- Status: Accepted
- Date: 2026-11-14

## Context

We integrate several external services (Overpass, Photon, Nominatim, OpenFreeMap, optionally
Google Maps). They differ in data formats, rate limits, terms of use and reliability. Community
instances can be slow or throttle. Paid providers must be pluggable without being the focus.

## Decision

1. **Ports** — the Application layer defines capability interfaces, e.g. `IGeocodingProvider`,
   `IRoadNetworkSource`, `IBasemapProvider` (later `IElevationProvider`). Use cases depend only on these.
2. **Anti-corruption layers** — each provider adapter lives in `TrafficSim.Providers/<Provider>`,
   owns its (internal) DTOs and maps them to canonical domain types (`GeocodeResult`,
   `OsmElementSet`, …). No provider type crosses the adapter boundary.
3. **Shared fetch pipeline** — all adapters use typed `HttpClient`s created by one registration
   helper that adds: identifying `User-Agent` with contact address, timeouts, retry with jitter,
   circuit breaker, a per-provider rate limiter, response caching (memory now, PostGIS/disk later),
   structured logging and metrics.
4. **Provider registry** — configuration (`Providers:<Name>:Enabled|BaseUrl|ApiKey|Priority|...`)
   decides which adapters are active. Composite services try providers by priority and fall back on
   failure (e.g. community Photon → self-hosted Photon → Nominatim).
5. Paid providers (Google Maps) are adapters behind the same ports, **disabled by default** and never required.

## Consequences

- Swapping or adding a provider touches one adapter plus configuration.
- Adapters are unit-tested with recorded fixtures and a fake `HttpMessageHandler` (C-33).
- Attribution strings travel with results so the UI can always display them.

## Alternatives considered

- Calling provider APIs from the browser: leaks keys, no caching, CORS issues, no fallback.
- A generic proxy endpoint: would leak provider formats into the frontend.
