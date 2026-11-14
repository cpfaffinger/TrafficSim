using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using Microsoft.Extensions.Options;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geocoding;
using TrafficSim.Providers.Http;

namespace TrafficSim.Providers.Nominatim;

/// <summary>
/// Nominatim adapter: fallback for forward geocoding and reverse geocoding. The public instance's
/// usage policy (1 request/s, identifying User-Agent, caching) is enforced by the fetch pipeline.
/// </summary>
public sealed class NominatimProvider : IGeocodingProvider, IReverseGeocodingProvider
{
    public const string ProviderName = "nominatim";
    public const string AttributionText = "Search by Nominatim · Data © OpenStreetMap contributors (ODbL)";

    private readonly HttpClient _httpClient;
    private readonly NominatimOptions _options;

    public NominatimProvider(HttpClient httpClient, IOptions<ProvidersOptions> options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _httpClient = httpClient;
        _options = options.Value.Nominatim;
    }

    public string Name => ProviderName;

    public int Priority => _options.Priority;

    public string Attribution => AttributionText;

    public Task<IReadOnlyList<GeocodeResult>> SearchAsync(GeocodeQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return ProviderErrors.GuardAsync<IReadOnlyList<GeocodeResult>>(ProviderName, async () =>
        {
            using var response = await _httpClient.GetAsync(new Uri(BuildSearchPath(query), UriKind.Relative), cancellationToken).ConfigureAwait(false);
            ProviderErrors.EnsureSuccess(ProviderName, response);
            var places = await response.Content.ReadFromJsonAsync<List<NominatimPlace>>(cancellationToken).ConfigureAwait(false);
            return (places ?? []).Select(NominatimMapper.Map).OfType<GeocodeResult>().ToList();
        }, cancellationToken);
    }

    public Task<GeocodeResult?> ReverseAsync(ReverseGeocodeQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return ProviderErrors.GuardAsync(ProviderName, async () =>
        {
            using var response = await _httpClient.GetAsync(new Uri(BuildReversePath(query), UriKind.Relative), cancellationToken).ConfigureAwait(false);
            ProviderErrors.EnsureSuccess(ProviderName, response);
            var place = await response.Content.ReadFromJsonAsync<NominatimPlace>(cancellationToken).ConfigureAwait(false);
            return NominatimMapper.Map(place);
        }, cancellationToken);
    }

    internal static string BuildSearchPath(GeocodeQuery query)
    {
        var sb = new StringBuilder("search?format=jsonv2&q=").Append(Uri.EscapeDataString(query.Text));
        sb.Append("&limit=").Append(query.Limit.ToString(CultureInfo.InvariantCulture));
        if (query.Language is not null)
        {
            sb.Append("&accept-language=").Append(Uri.EscapeDataString(query.Language));
        }

        return sb.ToString();
    }

    internal static string BuildReversePath(ReverseGeocodeQuery query)
    {
        var sb = new StringBuilder("reverse?format=jsonv2&lat=").Append(query.Location.Latitude.ToString("F6", CultureInfo.InvariantCulture));
        sb.Append("&lon=").Append(query.Location.Longitude.ToString("F6", CultureInfo.InvariantCulture));
        sb.Append("&zoom=18");
        if (query.Language is not null)
        {
            sb.Append("&accept-language=").Append(Uri.EscapeDataString(query.Language));
        }

        return sb.ToString();
    }
}
