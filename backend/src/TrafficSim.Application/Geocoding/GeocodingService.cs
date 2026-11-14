using Microsoft.Extensions.Logging;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Application.Geocoding;

/// <summary>Result of a geocoding request including the provider that answered.</summary>
public sealed record GeocodeResponse(IReadOnlyList<GeocodeResult> Results, string Provider, string Attribution);

/// <summary>Raised when no configured geocoding provider could answer.</summary>
public sealed class NoProviderAvailableException : Exception
{
    public NoProviderAvailableException()
    {
    }

    public NoProviderAvailableException(string message)
        : base(message)
    {
    }

    public NoProviderAvailableException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

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
        _providers = providers.OrderBy(p => p.Priority).ThenBy(p => p.Name, StringComparer.Ordinal).ToList();
        _logger = logger;
    }

    public IReadOnlyList<IGeocodingProvider> Providers => _providers;

    public async Task<GeocodeResponse> SearchAsync(GeocodeQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var failures = new List<Exception>();

        foreach (var provider in _providers)
        {
            try
            {
                var results = await provider.SearchAsync(query, cancellationToken).ConfigureAwait(false);
                return new GeocodeResponse(results, provider.Name, provider.Attribution);
            }
            catch (ProviderUnavailableException ex)
            {
                LogProviderFailed(provider.Name, ex.Message);
                failures.Add(ex);
            }
        }

        throw new NoProviderAvailableException(
            _providers.Count == 0 ? "No geocoding provider is configured." : "All geocoding providers failed.",
            new AggregateException(failures));
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Geocoding provider {Provider} failed, trying next: {Reason}")]
    private partial void LogProviderFailed(string provider, string reason);
}
