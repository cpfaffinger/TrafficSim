using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Api.Tests;

/// <summary>Returns one primary road through the requested area.</summary>
public sealed class FakeRoadNetworkSource : IRoadNetworkSource
{
    public string Name => "fake-roads";

    public int Priority => 1;

    public string Attribution => "Fake roads";

    public double MaxAreaSquareKilometers => 50;

    public Task<OsmDataSet> FetchAsync(BoundingBox area, CancellationToken cancellationToken)
    {
        var c = area.Center;
        return Task.FromResult(new OsmDataSet(
            [new OsmNode(1, new GeoPoint(c.Latitude, c.Longitude - 0.002)), new OsmNode(2, new GeoPoint(c.Latitude, c.Longitude + 0.002))],
            [new OsmWay(10, [1, 2], OsmTags.Of(("highway", "primary")))]));
    }
}
