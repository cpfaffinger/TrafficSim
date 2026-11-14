using TrafficSim.Application.Geocoding;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Application.Providers;

/// <summary>Port for reverse geocoding providers (ADR-0004).</summary>
public interface IReverseGeocodingProvider : IProvider
{
    /// <returns>The nearest feature, or <c>null</c> when the provider knows nothing at that location.</returns>
    /// <exception cref="ProviderUnavailableException">The provider failed or is unreachable.</exception>
    Task<GeocodeResult?> ReverseAsync(ReverseGeocodeQuery query, CancellationToken cancellationToken);
}
