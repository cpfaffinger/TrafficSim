using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using Microsoft.Extensions.Options;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Geocoding;
using TrafficSim.Providers.Http;

namespace TrafficSim.Providers.Google;

/// <summary>
/// Google Maps Geocoding API adapter. Commercial and disabled by default (C-08); used for search only —
/// never as a road network source (ADR-0005). Responses are not cached (Google terms).
/// </summary>
public sealed class GoogleGeocodingProvider : IGeocodingProvider
{
    public const string ProviderName = "google";
    public const string AttributionText = "Powered by Google";

    private readonly HttpClient _httpClient;
    private readonly GoogleOptions _options;

    public GoogleGeocodingProvider(HttpClient httpClient, IOptions<ProvidersOptions> options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _httpClient = httpClient;
        _options = options.Value.Google;
    }

    public string Name => ProviderName;

    public int Priority => _options.Priority;

    public string Attribution => AttributionText;

    public static bool IsUsable(GoogleOptions options) =>
        options is not null && options.Enabled && !string.IsNullOrWhiteSpace(options.ApiKey);

    public Task<IReadOnlyList<GeocodeResult>> SearchAsync(GeocodeQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return ProviderErrors.GuardAsync(ProviderName, async () =>
        {
            using var response = await _httpClient.GetAsync(new Uri(BuildSearchPath(query, _options.ApiKey ?? string.Empty), UriKind.Relative), cancellationToken).ConfigureAwait(false);
            ProviderErrors.EnsureSuccess(ProviderName, response);
            var body = await response.Content.ReadFromJsonAsync<GoogleGeocodeResponse>(cancellationToken).ConfigureAwait(false);
            return Map(body, query.Limit);
        }, cancellationToken);
    }

    internal static IReadOnlyList<GeocodeResult> Map(GoogleGeocodeResponse? body, int limit)
    {
        switch (body?.Status)
        {
            case "OK":
                break;
            case "ZERO_RESULTS":
                return [];
            default:
                throw new ProviderUnavailableException(ProviderName, $"status {body?.Status ?? "missing"}");
        }

        return (body.Results ?? [])
            .Select(MapResult)
            .OfType<GeocodeResult>()
            .Take(limit)
            .ToList();
    }

    private static GeocodeResult? MapResult(GoogleResult result)
    {
        if (result.Geometry?.Location is not { } loc || loc.Lat is < -90 or > 90 || loc.Lng is < -180 or > 180)
        {
            return null;
        }

        BoundingBox? extent = null;
        if (result.Geometry.Viewport is { Northeast: { } ne, Southwest: { } sw } && sw.Lat < ne.Lat && sw.Lng < ne.Lng)
        {
            extent = new BoundingBox(sw.Lat, sw.Lng, ne.Lat, ne.Lng);
        }

        var type = result.Types is { Count: > 0 } types ? types[0] : "unknown";
        return new GeocodeResult(result.FormattedAddress ?? "Unnamed place", new GeoPoint(loc.Lat, loc.Lng), $"google:{type}", extent);
    }

    internal static string BuildSearchPath(GeocodeQuery query, string apiKey)
    {
        var sb = new StringBuilder("maps/api/geocode/json?address=").Append(Uri.EscapeDataString(query.Text));
        if (query.Language is not null)
        {
            sb.Append("&language=").Append(Uri.EscapeDataString(query.Language));
        }

        if (query.Bias is { } bias)
        {
            // Bias via a ~20 km viewport around the point.
            const double d = 0.2;
            sb.Append(CultureInfo.InvariantCulture, $"&bounds={bias.Latitude - d:F6},{bias.Longitude - d:F6}|{bias.Latitude + d:F6},{bias.Longitude + d:F6}");
        }

        sb.Append("&key=").Append(Uri.EscapeDataString(apiKey));
        return sb.ToString();
    }
}
