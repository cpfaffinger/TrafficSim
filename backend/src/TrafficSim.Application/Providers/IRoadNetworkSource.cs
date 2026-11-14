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

    /// <summary>
    /// Fetches the roads of a polygon (#110). The default fetches its bounds; the compiler clips to the
    /// polygon anyway, sources that can filter server-side (Overpass) override this.
    /// </summary>
    Task<OsmDataSet> FetchAsync(GeoPolygon area, CancellationToken cancellationToken) =>
        FetchAsync((area ?? throw new ArgumentNullException(nameof(area))).Bounds, cancellationToken);
}
