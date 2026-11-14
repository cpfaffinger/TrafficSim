using System.Text.Json.Serialization;

namespace TrafficSim.Providers.Google;

// Internal DTOs of the Google Geocoding API. They never leave the adapter (ADR-0004).

internal sealed record GoogleGeocodeResponse(
    [property: JsonPropertyName("status")] string? Status,
    [property: JsonPropertyName("results")] IReadOnlyList<GoogleResult>? Results,
    [property: JsonPropertyName("error_message")] string? ErrorMessage);

internal sealed record GoogleResult(
    [property: JsonPropertyName("formatted_address")] string? FormattedAddress,
    [property: JsonPropertyName("geometry")] GoogleGeometry? Geometry,
    [property: JsonPropertyName("types")] IReadOnlyList<string>? Types);

internal sealed record GoogleGeometry(
    [property: JsonPropertyName("location")] GoogleLatLng? Location,
    [property: JsonPropertyName("viewport")] GoogleViewport? Viewport);

internal sealed record GoogleViewport(
    [property: JsonPropertyName("northeast")] GoogleLatLng? Northeast,
    [property: JsonPropertyName("southwest")] GoogleLatLng? Southwest);

internal sealed record GoogleLatLng(
    [property: JsonPropertyName("lat")] double Lat,
    [property: JsonPropertyName("lng")] double Lng);
