using System.Text.Json.Serialization;

namespace TrafficSim.Providers.Nominatim;

// Internal DTOs of Nominatim's format=jsonv2 responses. They never leave the adapter (ADR-0004).

internal sealed record NominatimPlace
{
    [JsonPropertyName("osm_type")] public string? OsmType { get; init; }

    [JsonPropertyName("osm_id")] public long? OsmId { get; init; }

    [JsonPropertyName("lat")] public string? Lat { get; init; }

    [JsonPropertyName("lon")] public string? Lon { get; init; }

    [JsonPropertyName("category")] public string? Category { get; init; }

    [JsonPropertyName("type")] public string? Type { get; init; }

    [JsonPropertyName("display_name")] public string? DisplayName { get; init; }

    /// <summary>Nominatim order: [minLat, maxLat, minLon, maxLon] as strings.</summary>
    [JsonPropertyName("boundingbox")] public IReadOnlyList<string>? BoundingBox { get; init; }

    [JsonPropertyName("error")] public string? Error { get; init; }
}
