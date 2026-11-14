using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using Microsoft.Extensions.Options;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geocoding;
using TrafficSim.Providers.Http;

namespace TrafficSim.Providers.Photon;

/// <summary>Photon (komoot community instance or self-hosted) forward and reverse geocoding adapter.</summary>
public sealed class PhotonGeocodingProvider : IGeocodingProvider, IReverseGeocodingProvider
{
    public const string ProviderName = "photon";
    public const string AttributionText = "Search by Photon (komoot) · Data © OpenStreetMap contributors (ODbL)";

    // Photon supports a fixed set of languages; others fall back to the default ("default" = local names).
    private static readonly HashSet<string> SupportedLanguages = new(StringComparer.Ordinal) { "en", "de", "fr", "it" };

    private readonly HttpClient _httpClient;
    private readonly PhotonOptions _options;

    public PhotonGeocodingProvider(HttpClient httpClient, IOptions<ProvidersOptions> options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _httpClient = httpClient;
        _options = options.Value.Photon;
    }

    public string Name => ProviderName;

    public int Priority => _options.Priority;

    public string Attribution => AttributionText;

    public Task<IReadOnlyList<GeocodeResult>> SearchAsync(GeocodeQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        return GetAsync(BuildSearchPath(query), cancellationToken);
    }

    public async Task<GeocodeResult?> ReverseAsync(ReverseGeocodeQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var results = await GetAsync(BuildReversePath(query), cancellationToken).ConfigureAwait(false);
        return results.Count == 0 ? null : results[0];
    }

    private Task<IReadOnlyList<GeocodeResult>> GetAsync(string path, CancellationToken cancellationToken) =>
        ProviderErrors.GuardAsync(ProviderName, async () =>
        {
            using var response = await _httpClient.GetAsync(new Uri(path, UriKind.Relative), cancellationToken).ConfigureAwait(false);
            ProviderErrors.EnsureSuccess(ProviderName, response);
            var collection = await response.Content
                .ReadFromJsonAsync<PhotonFeatureCollection>(cancellationToken)
                .ConfigureAwait(false);
            return PhotonMapper.Map(collection);
        }, cancellationToken);

    internal static string BuildSearchPath(GeocodeQuery query)
    {
        var sb = new StringBuilder("api/?q=").Append(Uri.EscapeDataString(query.Text));
        sb.Append("&limit=").Append(query.Limit.ToString(CultureInfo.InvariantCulture));
        AppendLanguage(sb, query.Language);
        if (query.Bias is { } bias)
        {
            sb.Append("&lat=").Append(bias.Latitude.ToString("F6", CultureInfo.InvariantCulture));
            sb.Append("&lon=").Append(bias.Longitude.ToString("F6", CultureInfo.InvariantCulture));
        }

        return sb.ToString();
    }

    internal static string BuildReversePath(ReverseGeocodeQuery query)
    {
        var sb = new StringBuilder("reverse?lat=").Append(query.Location.Latitude.ToString("F6", CultureInfo.InvariantCulture));
        sb.Append("&lon=").Append(query.Location.Longitude.ToString("F6", CultureInfo.InvariantCulture));
        sb.Append("&limit=1");
        AppendLanguage(sb, query.Language);
        return sb.ToString();
    }

    private static void AppendLanguage(StringBuilder sb, string? language)
    {
        if (language is not null && SupportedLanguages.Contains(language))
        {
            sb.Append("&lang=").Append(language);
        }
    }
}
