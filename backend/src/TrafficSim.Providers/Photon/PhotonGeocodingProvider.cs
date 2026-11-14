using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Providers.Photon;

/// <summary>Photon (komoot community instance or self-hosted) forward geocoding adapter.</summary>
public sealed class PhotonGeocodingProvider : IGeocodingProvider
{
    public const string ProviderName = "photon";

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

    public string Attribution => "Search by Photon (komoot) · Data © OpenStreetMap contributors (ODbL)";

    public async Task<IReadOnlyList<GeocodeResult>> SearchAsync(GeocodeQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var uri = new Uri(BuildSearchPath(query), UriKind.Relative);

        try
        {
            using var response = await _httpClient.GetAsync(uri, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                throw new ProviderUnavailableException(ProviderName, $"HTTP {(int)response.StatusCode}");
            }

            var collection = await response.Content
                .ReadFromJsonAsync<PhotonFeatureCollection>(cancellationToken)
                .ConfigureAwait(false);
            return PhotonMapper.Map(collection);
        }
        catch (HttpRequestException ex)
        {
            throw new ProviderUnavailableException(ProviderName, ex.Message, ex);
        }
        catch (JsonException ex)
        {
            throw new ProviderUnavailableException(ProviderName, "invalid response body", ex);
        }
        catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ProviderUnavailableException(ProviderName, "timeout", ex);
        }
        catch (Polly.CircuitBreaker.BrokenCircuitException ex)
        {
            throw new ProviderUnavailableException(ProviderName, "circuit open", ex);
        }
        catch (Polly.Timeout.TimeoutRejectedException ex)
        {
            throw new ProviderUnavailableException(ProviderName, "timeout", ex);
        }
    }

    internal static string BuildSearchPath(GeocodeQuery query)
    {
        var sb = new StringBuilder("api/?q=").Append(Uri.EscapeDataString(query.Text));
        sb.Append("&limit=").Append(query.Limit.ToString(CultureInfo.InvariantCulture));
        if (query.Language is not null && SupportedLanguages.Contains(query.Language))
        {
            sb.Append("&lang=").Append(query.Language);
        }

        if (query.Bias is { } bias)
        {
            sb.Append("&lat=").Append(bias.Latitude.ToString("F6", CultureInfo.InvariantCulture));
            sb.Append("&lon=").Append(bias.Longitude.ToString("F6", CultureInfo.InvariantCulture));
        }

        return sb.ToString();
    }
}
