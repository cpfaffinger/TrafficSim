using System.Net.Http.Json;
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

    public OverpassRoadNetworkSource(HttpClient httpClient, IOptions<ProvidersOptions> options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _httpClient = httpClient;
        _options = options.Value.Overpass;
    }

    public string Name => ProviderName;

    public int Priority => _options.Priority;

    public string Attribution => AttributionText;

    public double MaxAreaSquareKilometers => _options.MaxAreaSquareKilometers;

    public Task<OsmDataSet> FetchAsync(BoundingBox area, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(area);
        return FetchQueryAsync(OverpassQuery.Build(area, _options.QueryTimeoutSeconds), cancellationToken);
    }

    public Task<OsmDataSet> FetchAsync(GeoPolygon area, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(area);
        return FetchQueryAsync(OverpassQuery.Build(area, _options.QueryTimeoutSeconds), cancellationToken);
    }

    private Task<OsmDataSet> FetchQueryAsync(string query, CancellationToken cancellationToken) =>
        FirstAvailableAsync(_options, endpoint => FetchFromAsync(endpoint, query, cancellationToken));

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

    private Task<OsmDataSet> FetchFromAsync(Uri endpoint, string query, CancellationToken cancellationToken) =>
        ProviderErrors.GuardAsync(ProviderName, async () =>
        {
            using var response = await _httpClient.GetAsync(BuildUri(endpoint, query), HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
            ProviderErrors.EnsureSuccess(ProviderName, response);
            var body = await response.Content.ReadFromJsonAsync<OverpassResponse>(cancellationToken).ConfigureAwait(false);
            return OverpassMapper.Map(body);
        }, cancellationToken);
}
