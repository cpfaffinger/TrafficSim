using TrafficSim.Domain.Geo;

namespace TrafficSim.Domain.Geocoding;

/// <summary>
/// Canonical, provider-independent geocoding result. Provider adapters translate their own
/// formats into this type (anti-corruption layer, ADR-0004).
/// </summary>
/// <param name="Label">Human-readable single-line label.</param>
/// <param name="Location">Representative point.</param>
/// <param name="Category">Coarse category, e.g. "highway:motorway" or "place:city".</param>
/// <param name="Extent">Optional extent of the feature.</param>
/// <param name="OsmReference">Optional OSM reference such as "way/123".</param>
public sealed record GeocodeResult(
    string Label,
    GeoPoint Location,
    string Category,
    BoundingBox? Extent = null,
    string? OsmReference = null);
