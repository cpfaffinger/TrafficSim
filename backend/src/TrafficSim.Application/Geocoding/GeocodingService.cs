using Microsoft.Extensions.Logging;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Application.Geocoding;

/// <summary>Result of a geocoding request including the provider that answered.</summary>
public sealed record GeocodeResponse(IReadOnlyList<GeocodeResult> Results, string Provider, string Attribution);

/// <summary>
/// Forward geocoding use case. Tries providers by priority and falls back to the next one when a
/// provider is unavailable. An empty result is a valid answer and does not trigger a fallback.
/// </summary>
public sealed partial class GeocodingService
{
    private readonly IReadOnlyList<IGeocodingProvider> _providers;
    private readonly ILogger<GeocodingService> _logger;

    public GeocodingService(IEnumerable<IGeocodingProvider> providers, ILogger<GeocodingService> logger)
    {
        _providers = ProviderFallback.Order(providers);
        _logger = logger;
    }

    public IReadOnlyList<IGeocodingProvider> Providers => _providers;

    public async Task<GeocodeResponse> SearchAsync(GeocodeQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var answer = await ProviderFallback.FirstAvailableAsync(
            _providers,
            "geocoding",
            p => p.SearchAsync(query, cancellationToken),
            (p, ex) => LogProviderFailed(p.Name, ex.Message)).ConfigureAwait(false);
        return new GeocodeResponse(answer.Value, answer.Provider, answer.Attribution);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Geocoding provider {Provider} failed, trying next: {Reason}")]
    private partial void LogProviderFailed(string provider, string reason);
}
