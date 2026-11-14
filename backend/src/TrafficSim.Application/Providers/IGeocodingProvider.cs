using TrafficSim.Application.Geocoding;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Application.Providers;

/// <summary>Port for forward geocoding providers (ADR-0004).</summary>
public interface IGeocodingProvider
{
    /// <summary>Stable provider name used in configuration and responses.</summary>
    string Name { get; }

    /// <summary>Lower value = tried first.</summary>
    int Priority { get; }

    /// <summary>Attribution text that must be displayed with results.</summary>
    string Attribution { get; }

    /// <exception cref="ProviderUnavailableException">The provider failed or is unreachable.</exception>
    Task<IReadOnlyList<GeocodeResult>> SearchAsync(GeocodeQuery query, CancellationToken cancellationToken);
}
