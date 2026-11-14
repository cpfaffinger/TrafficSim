using TrafficSim.Application.Geocoding;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Application.Providers;

/// <summary>Port for forward geocoding providers (ADR-0004).</summary>
public interface IGeocodingProvider : IProvider
{
    /// <exception cref="ProviderUnavailableException">The provider failed or is unreachable.</exception>
    Task<IReadOnlyList<GeocodeResult>> SearchAsync(GeocodeQuery query, CancellationToken cancellationToken);
}
