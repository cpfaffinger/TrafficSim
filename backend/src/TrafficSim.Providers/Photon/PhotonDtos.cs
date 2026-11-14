using System.Text.Json;
using System.Text.Json.Serialization;

namespace TrafficSim.Providers.Photon;

// Internal DTOs mirroring Photon's GeoJSON response. They never leave the adapter (ADR-0004).

internal sealed record PhotonFeatureCollection(
    [property: JsonPropertyName("features")] IReadOnlyList<PhotonFeature>? Features);

internal sealed record PhotonFeature(
    [property: JsonPropertyName("geometry")] PhotonGeometry? Geometry,
    [property: JsonPropertyName("properties")] PhotonProperties? Properties);

internal sealed record PhotonGeometry(
    [property: JsonPropertyName("type")] string? Type,
    [property: JsonPropertyName("coordinates")] IReadOnlyList<double>? Coordinates);

internal sealed record PhotonProperties
{
    [JsonPropertyName("osm_type")] public string? OsmType { get; init; }

    [JsonPropertyName("osm_id")] public long? OsmId { get; init; }

    [JsonPropertyName("osm_key")] public string? OsmKey { get; init; }

    [JsonPropertyName("osm_value")] public string? OsmValue { get; init; }

    [JsonPropertyName("name")] public string? Name { get; init; }

    [JsonPropertyName("street")] public string? Street { get; init; }

    [JsonPropertyName("housenumber")] public string? HouseNumber { get; init; }

    [JsonPropertyName("postcode")] public string? Postcode { get; init; }

    [JsonPropertyName("city")] public string? City { get; init; }

    [JsonPropertyName("state")] public string? State { get; init; }

    [JsonPropertyName("country")] public string? Country { get; init; }

    /// <summary>Photon extent order: [minLon, maxLat, maxLon, minLat].</summary>
    [JsonPropertyName("extent")] public IReadOnlyList<double>? Extent { get; init; }

    [JsonExtensionData] public IDictionary<string, JsonElement>? Additional { get; init; }
}
