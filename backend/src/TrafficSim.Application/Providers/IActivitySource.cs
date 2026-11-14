using TrafficSim.Domain.Activity;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Application.Providers;

/// <summary>Port for OSM buildings, land use and POIs used to generate demand (#115).</summary>
public interface IActivitySource : IProvider
{
    double MaxAreaSquareKilometers { get; }

    /// <exception cref="ProviderUnavailableException">The source failed or is unreachable.</exception>
    Task<IReadOnlyList<OsmPoi>> FetchAsync(GeoPolygon area, CancellationToken cancellationToken);
}
