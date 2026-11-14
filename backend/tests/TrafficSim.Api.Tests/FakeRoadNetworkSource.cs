using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Activity;
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

/// <summary>Buildings around the area centre: apartments west, offices east (no network calls).</summary>
public sealed class FakeActivitySource : IActivitySource
{
    public string Name => "fake-activity";

    public int Priority => 1;

    public string Attribution => "Fake activity";

    public double MaxAreaSquareKilometers => 50;

    public Task<IReadOnlyList<OsmPoi>> FetchAsync(GeoPolygon area, CancellationToken cancellationToken)
    {
        var c = area.Bounds.Center;
        IReadOnlyList<OsmPoi> pois =
        [
            new(new GeoPoint(c.Latitude + 0.0002, c.Longitude - 0.0015), OsmTags.Of(("building", "apartments"), ("building:levels", "5"))),
            new(new GeoPoint(c.Latitude - 0.0002, c.Longitude + 0.0015), OsmTags.Of(("building", "office"))),
            new(new GeoPoint(c.Latitude + 0.0001, c.Longitude), OsmTags.Of(("shop", "supermarket"))),
        ];
        return Task.FromResult(pois);
    }
}
