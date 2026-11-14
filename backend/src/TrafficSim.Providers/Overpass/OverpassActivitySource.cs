using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Activity;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;
using TrafficSim.Providers.Http;

namespace TrafficSim.Providers.Overpass;

internal sealed record OverpassCentre([property: JsonPropertyName("lat")] double Lat, [property: JsonPropertyName("lon")] double Lon);

internal sealed record OverpassPoiElement(
    [property: JsonPropertyName("type")] string? Type,
    [property: JsonPropertyName("lat")] double? Lat,
    [property: JsonPropertyName("lon")] double? Lon,
    [property: JsonPropertyName("center")] OverpassCentre? Center,
    [property: JsonPropertyName("tags")] IReadOnlyDictionary<string, string>? Tags);

internal sealed record OverpassPoiResponse(
    [property: JsonPropertyName("elements")] IReadOnlyList<OverpassPoiElement>? Elements,
    [property: JsonPropertyName("remark")] string? Remark);

/// <summary>
/// Buildings, land use and POIs of an import area from Overpass (#115): one query, element centres
/// and tags only (no geometry), so even dense city areas stay small.
/// </summary>
public sealed class OverpassActivitySource : IActivitySource
{
    public const string ProviderName = "overpass-activity";

    private readonly HttpClient _httpClient;
    private readonly OverpassOptions _options;

    public OverpassActivitySource(HttpClient httpClient, IOptions<ProvidersOptions> options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _httpClient = httpClient;
        _options = options.Value.Overpass;
    }

    public string Name => ProviderName;

    public int Priority => _options.Priority;

    public string Attribution => OverpassRoadNetworkSource.AttributionText;

    public double MaxAreaSquareKilometers => _options.MaxAreaSquareKilometers;

    internal static string BuildQuery(GeoPolygon area, int timeoutSeconds)
    {
        ArgumentNullException.ThrowIfNull(area);
        var filter = area.IsRectangle
            ? string.Create(CultureInfo.InvariantCulture, $"({area.Bounds.South:F7},{area.Bounds.West:F7},{area.Bounds.North:F7},{area.Bounds.East:F7})")
            : "(poly:\"" + string.Join(' ', area.Ring.Select(p => string.Create(CultureInfo.InvariantCulture, $"{p.Latitude:F7} {p.Longitude:F7}"))) + "\")";
        var timeout = timeoutSeconds.ToString(CultureInfo.InvariantCulture);
        return $"[out:json][timeout:{timeout}];(" +
            $"nwr[\"building\"~\"^(apartments|residential|dormitory|house|detached|semidetached_house|bungalow|terrace|office|commercial|retail|industrial|warehouse)$\"]{filter};" +
            $"nwr[\"landuse\"~\"^(residential|commercial|retail|industrial)$\"]{filter};" +
            $"nwr[\"shop\"]{filter};nwr[\"office\"]{filter};" +
            $"nwr[\"amenity\"~\"^(school|kindergarten|university|college|hospital|townhall|marketplace|theatre|cinema|arts_centre|events_venue|parking)$\"]{filter};" +
            $"nwr[\"leisure\"~\"^(stadium|sports_centre)$\"]{filter};" +
            ");out center tags;";
    }

    public Task<IReadOnlyList<OsmPoi>> FetchAsync(GeoPolygon area, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(area);
        var uri = OverpassRoadNetworkSource.BuildUri(_options.BaseUrl, BuildQuery(area, _options.QueryTimeoutSeconds));
        return ProviderErrors.GuardAsync<IReadOnlyList<OsmPoi>>(ProviderName, async () =>
        {
            using var response = await _httpClient.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            ProviderErrors.EnsureSuccess(ProviderName, response);
            var body = await response.Content.ReadFromJsonAsync<OverpassPoiResponse>(cancellationToken).ConfigureAwait(false);
            if (body?.Elements is null || (body.Remark?.Contains("runtime error", StringComparison.OrdinalIgnoreCase) ?? false))
            {
                throw new ProviderUnavailableException(ProviderName, body?.Remark ?? "response without elements");
            }

            return Map(body.Elements);
        }, cancellationToken);
    }

    internal static List<OsmPoi> Map(IEnumerable<OverpassPoiElement> elements) => elements
        .Select(e => (Point: e.Lat is { } lat && e.Lon is { } lon ? (lat, lon) : e.Center is { } c ? (c.Lat, c.Lon) : ((double, double)?)null, e.Tags))
        .Where(x => x.Point is { } p && p.Item1 is >= -90 and <= 90 && p.Item2 is >= -180 and <= 180 && x.Tags is { Count: > 0 })
        .Select(x => new OsmPoi(new GeoPoint(x.Point!.Value.Item1, x.Point.Value.Item2), new Dictionary<string, string>(x.Tags!, StringComparer.Ordinal)))
        .ToList();
}
