using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Providers;

/// <summary>Port for sources of raw OSM road network data (Overpass, Geofabrik extracts; ADR-0005).</summary>
public interface IRoadNetworkSource : IProvider
{
    /// <summary>Largest area this source accepts per request.</summary>
    double MaxAreaSquareKilometers { get; }

    /// <summary>Fetches all drivable ways and their nodes intersecting <paramref name="area"/>.</summary>
    /// <exception cref="ProviderUnavailableException">The source failed or is unreachable.</exception>
    Task<OsmDataSet> FetchAsync(BoundingBox area, CancellationToken cancellationToken);
}
