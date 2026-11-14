using TrafficSim.Domain.Geo;

namespace TrafficSim.Application.Providers;

/// <summary>Port for terrain heights (#87, ADR-0018): a point sampler over a digital elevation model.</summary>
public interface IElevationProvider : IProvider
{
    /// <summary>
    /// Heights above sea level in metres (source datum) for <paramref name="points"/>, in the same order;
    /// null where the source has no data.
    /// </summary>
    /// <exception cref="ProviderUnavailableException">The source failed or is unreachable.</exception>
    Task<IReadOnlyList<double?>> SampleAsync(IReadOnlyList<GeoPoint> points, CancellationToken cancellationToken);
}
