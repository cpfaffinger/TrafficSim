using System.Text.Json;
using Microsoft.Extensions.Options;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;
using TrafficSim.Providers.Http;

namespace TrafficSim.Providers.Overpass;

/// <summary>
/// Overpass API adapter for small areas. Tries the primary community instance and then each mirror;
/// all of them share the pipeline's rate limit and cache.
/// </summary>
public sealed class OverpassRoadNetworkSource : IRoadNetworkSource
{
    public const string ProviderName = "overpass";
    public const string AttributionText = "Data © OpenStreetMap contributors (ODbL) via Overpass API";

    private readonly HttpClient _httpClient;
    private readonly OverpassOptions _options;
    private readonly OverpassAreaCache? _areaCache;

    public OverpassRoadNetworkSource(HttpClient httpClient, IOptions<ProvidersOptions> options, IEnumerable<IResponseCache>? caches = null, TimeProvider? time = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        _httpClient = httpClient;
        _options = options.Value.Overpass;
        if (caches?.FirstOrDefault() is { } cache && _options.AreaCacheTtl > TimeSpan.Zero)
        {
            _areaCache = new OverpassAreaCache(cache, time ?? TimeProvider.System, _options.AreaCacheTtl);
        }
    }

    public string Name => ProviderName;

    public int Priority => _options.Priority;

    public string Attribution => AttributionText;

    public double MaxAreaSquareKilometers => _options.MaxAreaSquareKilometers;

    public Task<OsmDataSet> FetchAsync(BoundingBox area, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(area);
        return _areaCache is { } cache
            ? FetchCachedAsync(cache, area, cancellationToken)
            : FetchQueryAsync(OverpassQuery.Build(area, _options.QueryTimeoutSeconds), cancellationToken);
    }

    public Task<OsmDataSet> FetchAsync(GeoPolygon area, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(area);
        // With the area cache, a polygon fetches its bounds (#138): cached areas stay rectangles, and the
        // compiler clips the data to the polygon anyway.
        return _areaCache is { } cache && area.Bounds.AreaSquareKilometers <= _options.MaxAreaSquareKilometers
            ? FetchCachedAsync(cache, area.Bounds, cancellationToken)
            : FetchQueryAsync(OverpassQuery.Build(area, _options.QueryTimeoutSeconds), cancellationToken);
    }

    private async Task<OsmDataSet> FetchCachedAsync(OverpassAreaCache cache, BoundingBox area, CancellationToken cancellationToken)
    {
        if (await cache.FindAsync(area, cancellationToken).ConfigureAwait(false) is { } cached)
        {
            try
            {
                return Map(cached);
            }
            catch (Exception ex) when (ex is JsonException or ProviderUnavailableException)
            {
                // a broken entry is a miss
            }
        }

        var query = OverpassQuery.Build(area, _options.QueryTimeoutSeconds);
        var (data, raw) = await FirstAvailableAsync(_options, endpoint => FetchRawFromAsync(endpoint, query, cancellationToken)).ConfigureAwait(false);
        await cache.StoreAsync(area, raw, cancellationToken).ConfigureAwait(false);
        return data;
    }

    private Task<OsmDataSet> FetchQueryAsync(string query, CancellationToken cancellationToken) =>
        FirstAvailableAsync(_options, async endpoint => (await FetchRawFromAsync(endpoint, query, cancellationToken).ConfigureAwait(false)).Data);

    /// <summary>Runs <paramref name="fetch"/> against the primary instance and then each mirror until one answers.</summary>
    internal static async Task<T> FirstAvailableAsync<T>(OverpassOptions options, Func<Uri, Task<T>> fetch)
    {
        var endpoints = new[] { options.BaseUrl }.Concat(options.Mirrors).Distinct().ToList();
        ProviderUnavailableException? last = null;

        foreach (var endpoint in endpoints)
        {
            try
            {
                return await fetch(endpoint).ConfigureAwait(false);
            }
            catch (ProviderUnavailableException ex)
            {
                last = ex;
            }
        }

        throw last ?? new ProviderUnavailableException(ProviderName, "no endpoint configured");
    }

    internal static Uri BuildUri(Uri endpoint, string query) =>
        new(endpoint, "interpreter?data=" + Uri.EscapeDataString(query));

    /// <summary>Fetches and maps a query; also returns the raw body, unchanged, for the area cache.</summary>
    private Task<(OsmDataSet Data, byte[] Raw)> FetchRawFromAsync(Uri endpoint, string query, CancellationToken cancellationToken) =>
        ProviderErrors.GuardAsync(ProviderName, async () =>
        {
            using var response = await _httpClient.GetAsync(BuildUri(endpoint, query), HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            ProviderErrors.EnsureSuccess(ProviderName, response);
            var raw = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
            return (Map(raw), raw);
        }, cancellationToken);

    private static OsmDataSet Map(byte[] raw) =>
        OverpassMapper.Map(JsonSerializer.Deserialize<OverpassResponse>(raw, JsonSerializerOptions.Web));
}
