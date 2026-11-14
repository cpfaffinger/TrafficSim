# ADR-0014: Licensing — MIT for code, ODbL attribution for data

- Status: Accepted
- Date: 2026-11-14

## Decision

- All source code in this repository is licensed under the **MIT License**.
- Map data from OpenStreetMap is © OpenStreetMap contributors under the **ODbL 1.0**. The UI shows
  attribution for every active data and tile provider. Exported networks derived from OSM carry the ODbL notice.
- Third-party services are used according to their own terms (see [concept §6](../concept.md#6-external-data-sources-and-usage-policies)).

## Consequences

- Maximum reuse of the code; data obligations are handled in the product (attribution) and in the docs.
