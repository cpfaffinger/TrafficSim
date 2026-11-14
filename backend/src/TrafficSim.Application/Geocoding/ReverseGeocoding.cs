using Microsoft.Extensions.Logging;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Application.Geocoding;

/// <summary>A validated reverse-geocoding query.</summary>
public sealed record ReverseGeocodeQuery
{
    public ReverseGeocodeQuery(GeoPoint location, string? language = null)
    {
        Location = location;
        Language = string.IsNullOrWhiteSpace(language) ? null : language.Trim().ToLowerInvariant();
    }

    public GeoPoint Location { get; }

    public string? Language { get; }
}

/// <summary>Result of a reverse geocoding request; <see cref="Result"/> is null when nothing is nearby.</summary>
public sealed record ReverseGeocodeResponse(GeocodeResult? Result, string Provider, string Attribution);

/// <summary>Reverse geocoding use case with priority fallback.</summary>
public sealed partial class ReverseGeocodingService(
    IEnumerable<IReverseGeocodingProvider> providers,
    ILogger<ReverseGeocodingService> logger)
{
    private readonly IReadOnlyList<IReverseGeocodingProvider> _providers = ProviderFallback.Order(providers);
    private readonly ILogger<ReverseGeocodingService> _logger = logger;

    public async Task<ReverseGeocodeResponse> ReverseAsync(ReverseGeocodeQuery query, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var answer = await ProviderFallback.FirstAvailableAsync(
            _providers,
            "reverse geocoding",
            p => p.ReverseAsync(query, cancellationToken),
            (p, ex) => LogProviderFailed(p.Name, ex.Message)).ConfigureAwait(false);
        return new ReverseGeocodeResponse(answer.Value, answer.Provider, answer.Attribution);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Reverse geocoding provider {Provider} failed, trying next: {Reason}")]
    private partial void LogProviderFailed(string provider, string reason);
}
