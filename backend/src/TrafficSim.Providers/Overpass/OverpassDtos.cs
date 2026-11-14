using System.Text.Json.Serialization;

namespace TrafficSim.Providers.Overpass;

// Internal DTOs of Overpass API JSON output. They never leave the adapter (ADR-0004).

internal sealed record OverpassResponse(
    [property: JsonPropertyName("osm3s")] OverpassMeta? Meta,
    [property: JsonPropertyName("elements")] IReadOnlyList<OverpassElement>? Elements,
    [property: JsonPropertyName("remark")] string? Remark);

internal sealed record OverpassMeta(
    [property: JsonPropertyName("timestamp_osm_base")] DateTimeOffset? TimestampOsmBase);

internal sealed record OverpassElement(
    [property: JsonPropertyName("type")] string? Type,
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("lat")] double? Lat,
    [property: JsonPropertyName("lon")] double? Lon,
    [property: JsonPropertyName("nodes")] IReadOnlyList<long>? Nodes,
    [property: JsonPropertyName("tags")] IReadOnlyDictionary<string, string>? Tags,
    [property: JsonPropertyName("members")] IReadOnlyList<OverpassMember>? Members = null);

internal sealed record OverpassMember(
    [property: JsonPropertyName("type")] string? Type,
    [property: JsonPropertyName("ref")] long Ref,
    [property: JsonPropertyName("role")] string? Role);
