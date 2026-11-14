using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Domain.Tests.Osm;

public class OsmDataSetTests
{
    [Fact]
    public void Keeps_ways_with_resolved_nodes_and_trims_missing_references()
    {
        var nodes = new[] { new OsmNode(1, new GeoPoint(0, 0)), new OsmNode(2, new GeoPoint(0, 1)), new OsmNode(3, new GeoPoint(0, 2)) };
        var complete = new OsmWay(10, [1, 2, 3], OsmTags.Of(("highway", "primary")));
        var partial = new OsmWay(11, [1, 99, 2], OsmTags.Empty);
        var dangling = new OsmWay(12, [1, 98], OsmTags.Empty);

        var data = new OsmDataSet(nodes, [complete, partial, dangling], DateTimeOffset.UnixEpoch);

        Assert.Equal(3, data.Nodes.Count);
        Assert.Equal([10L, 11L], data.Ways.Select(w => w.Id));
        Assert.Same(complete, data.Ways[0]);
        Assert.Equal([1L, 2L], data.Ways[1].NodeIds);
        Assert.Equal(DateTimeOffset.UnixEpoch, data.DataTimestamp);
        Assert.Equal("primary", data.Ways[0].Tags["highway"]);
        Assert.Empty(nodes[0].Tags);
    }
}
