using TrafficSim.Domain.Network;
using TrafficSim.Domain.Network.Compilation;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Domain.Tests.Network;

public class CrossingRuleTests
{
    [Theory]
    [InlineData("crossing", "traffic_signals", null, null, CrossingKind.Signal)]
    [InlineData("crossing", "zebra", null, null, CrossingKind.Zebra)]
    [InlineData("crossing", "uncontrolled", "zebra", null, CrossingKind.Zebra)]
    [InlineData("crossing", "marked", null, "zebra", CrossingKind.Zebra)]
    [InlineData("crossing", "marked", null, "zebra:double", CrossingKind.Zebra)]
    [InlineData("crossing", "uncontrolled", null, null, CrossingKind.Uncontrolled)]
    [InlineData("crossing", "marked", null, "lines", CrossingKind.Uncontrolled)]
    [InlineData("crossing", "unmarked", null, null, CrossingKind.Unmarked)]
    [InlineData("crossing", "informal", null, null, CrossingKind.Unmarked)]
    [InlineData("crossing", null, null, null, CrossingKind.Unmarked)]
    [InlineData("crossing", null, null, "zebra", CrossingKind.Zebra)]
    [InlineData("traffic_signals", "traffic_signals", null, null, CrossingKind.Signal)]
    [InlineData("traffic_signals", "uncontrolled", null, null, CrossingKind.Signal)]
    public void Classifies_crossing_nodes(string highway, string? crossing, string? crossingRef, string? markings, CrossingKind expected)
    {
        var tags = new List<(string, string)> { ("highway", highway) };
        if (crossing is not null)
        {
            tags.Add(("crossing", crossing));
        }

        if (crossingRef is not null)
        {
            tags.Add(("crossing_ref", crossingRef));
        }

        if (markings is not null)
        {
            tags.Add(("crossing:markings", markings));
        }

        Assert.Equal(expected, CrossingRule.ClassifyNode(OsmTags.Of([.. tags])));
    }

    [Fact]
    public void Non_crossings_are_not_classified()
    {
        Assert.Null(CrossingRule.ClassifyNode(OsmTags.Of(("highway", "crossing"), ("crossing", "no"))));
        Assert.Null(CrossingRule.ClassifyNode(OsmTags.Of(("highway", "traffic_signals"))));
        Assert.Null(CrossingRule.ClassifyNode(OsmTags.Of(("highway", "stop"))));
        Assert.Null(CrossingRule.ClassifyNode(OsmTags.Empty));
        Assert.Equal(CrossingKind.Signal, CrossingRule.ClassifyNode(OsmTags.Of(("highway", "crossing"), ("crossing:signals", "yes"))));
        Assert.Equal(CrossingKind.Zebra, CrossingRule.ClassifyWay(OsmTags.Of(("highway", "footway"), ("footway", "crossing"), ("crossing", "zebra"))));
        Assert.Equal(CrossingKind.Unmarked, CrossingRule.ClassifyWay(OsmTags.Of(("highway", "footway"), ("footway", "crossing"))));
        Assert.Null(CrossingRule.ClassifyWay(OsmTags.Of(("highway", "footway"))));
        Assert.Null(CrossingRule.ClassifyWay(OsmTags.Of(("highway", "footway"), ("footway", "crossing"), ("crossing", "no"))));
        Assert.True(CrossingRule.IsSignalisedCrossing(OsmTags.Of(("highway", "crossing"), ("crossing", "traffic_signals"))));
        Assert.False(CrossingRule.IsSignalisedCrossing(OsmTags.Of(("highway", "crossing"), ("crossing", "zebra"))));
    }

    [Fact]
    public void Base_demand_follows_road_class_and_kind()
    {
        Assert.True(CrossingRule.BaseDemand(RoadClass.Primary, CrossingKind.Zebra, false) > CrossingRule.BaseDemand(RoadClass.Residential, CrossingKind.Zebra, false));
        Assert.True(CrossingRule.BaseDemand(RoadClass.Primary, CrossingKind.Zebra, false) > CrossingRule.BaseDemand(RoadClass.Primary, CrossingKind.Unmarked, false));
        Assert.True(CrossingRule.BaseDemand(RoadClass.Primary, CrossingKind.Signal, true) < CrossingRule.BaseDemand(RoadClass.Primary, CrossingKind.Signal, false));
        Assert.Equal(0, CrossingRule.BaseDemand(RoadClass.Motorway, CrossingKind.Signal, false));
    }
}

public class CrossingCompilerTests
{
    private static RoadNetwork Compile(OsmBuilder b) => NetworkCompiler.Compile(b.Build(), b.Area());

    [Fact]
    public void Zebra_on_a_two_way_road_crosses_both_directions()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0, ("highway", "crossing"), ("crossing", "zebra")).Node(3, 200, 0)
            .Way(10, [1, 2, 3], ("highway", "secondary"));
        var net = Compile(b);

        var x = Assert.Single(net.Crossings);
        Assert.Equal("x0", x.Id);
        Assert.Equal(2, x.OsmId);
        Assert.Equal(CrossingKind.Zebra, x.Kind);
        Assert.Equal(CrossingSignalMode.None, x.SignalMode);
        Assert.False(x.Implicit);
        Assert.Equal(7.0, x.Width, 2); // two 3.5 m secondary lanes
        Assert.Equal(2, x.Links.Count);
        Assert.True(x.Demand > 0);
        var east = net.Links.Single(l => l.OsmForward);
        var west = net.Links.Single(l => !l.OsmForward);
        var e = x.Links.Single(c => c.LinkId == east.Id);
        var w = x.Links.Single(c => c.LinkId == west.Id);
        Assert.Equal(200, e.Position, 1);
        Assert.Equal(200, w.Position, 1);
        // The first kerb is the right kerb of the first link; the opposite direction occupies the far half.
        Assert.Equal((0, 3.5), (e.SpanFrom, e.SpanTo));
        Assert.Equal(3.5, w.SpanFrom, 3);
        Assert.Equal(7.0, w.SpanTo, 3);
        Assert.Equal(2, x.Geometry.Count);
        Assert.Equal(-3.5, x.Geometry[0].Y, 2); // right kerb of the eastbound link
        Assert.Equal(3.5, x.Geometry[1].Y, 2);
        Assert.Equal(0, x.Geometry[0].X, 2);
    }

    [Fact]
    public void Crossing_on_a_one_way_road_spans_its_lanes()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 50, 0, ("highway", "crossing"), ("crossing", "unmarked")).Node(3, 200, 0)
            .Way(10, [1, 2, 3], ("highway", "residential"), ("oneway", "yes"), ("lanes", "2"));
        var net = Compile(b);

        var x = Assert.Single(net.Crossings);
        Assert.Equal(CrossingKind.Unmarked, x.Kind);
        var entry = Assert.Single(x.Links);
        Assert.Equal(250, entry.Position, 1);
        Assert.Equal(6.5, x.Width, 2);
        Assert.Equal((0, 6.5), (entry.SpanFrom, Math.Round(entry.SpanTo, 3)));
    }

    [Fact]
    public void Crossing_at_a_way_joint_attaches_to_the_incoming_links()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0, ("highway", "crossing"), ("crossing", "uncontrolled")).Node(3, 200, 0)
            .Way(10, [1, 2], ("highway", "tertiary"))
            .Way(11, [2, 3], ("highway", "tertiary"));
        var net = Compile(b);

        var x = Assert.Single(net.Crossings);
        Assert.Equal(CrossingKind.Uncontrolled, x.Kind);
        Assert.Equal(2, x.Links.Count);
        var joint = net.Nodes.Single(n => n.OsmId == 2).Id;
        Assert.All(x.Links, c =>
        {
            var link = net.Links.Single(l => l.Id == c.LinkId);
            Assert.Equal(joint, link.To);
            Assert.Equal(link.Length, c.Position, 3);
        });
    }

    [Fact]
    public void Footway_crossing_ways_are_a_fallback()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0).Node(3, 200, 0).Node(4, 0, 10).Node(5, 0, -10)
            .Way(10, [1, 2, 3], ("highway", "residential"))
            .Way(20, [4, 2, 5], ("highway", "footway"), ("footway", "crossing"), ("crossing", "zebra"));
        var net = Compile(b);

        var x = Assert.Single(net.Crossings);
        Assert.Equal(CrossingKind.Zebra, x.Kind);
        Assert.Equal(2, x.OsmId);
        Assert.Equal(2, net.Links.Count); // the footway is no road and does not split it
    }

    [Fact]
    public void Ignores_crossing_no_and_crossings_at_junction_nodes()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0, ("highway", "crossing")).Node(3, 200, 0).Node(4, 0, 200)
            .Node(6, -100, 0, ("highway", "crossing"), ("crossing", "no"))
            .Way(10, [1, 6, 2, 3], ("highway", "residential"))
            .Way(11, [2, 4], ("highway", "residential"));
        var net = Compile(b);

        Assert.Empty(net.Crossings);
    }

    [Fact]
    public void Mid_block_pedestrian_signal_becomes_a_request_crossing()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0, ("highway", "crossing"), ("crossing", "traffic_signals")).Node(3, 200, 0)
            .Way(10, [1, 2, 3], ("highway", "primary"));
        var net = Compile(b);

        var signalNode = net.Nodes.Single(n => n.OsmId == 2);
        Assert.Equal(NodeControl.Signal, signalNode.Control);
        var controller = Assert.Single(net.Signals);
        var x = Assert.Single(net.Crossings);
        Assert.Equal(CrossingKind.Signal, x.Kind);
        Assert.Equal(CrossingSignalMode.Request, x.SignalMode);
        Assert.Equal(controller.Groups[0].Id, x.SignalGroup);
        Assert.Equal(signalNode.Id, x.NodeId);
        Assert.All(x.Links, c => Assert.Equal(signalNode.Id, net.Links.Single(l => l.Id == c.LinkId).To));
    }

    [Fact]
    public void Mid_block_traffic_signals_without_a_mapped_crossing_get_an_implicit_one()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0, ("highway", "traffic_signals")).Node(3, 200, 0)
            .Way(10, [1, 2, 3], ("highway", "primary"));
        var net = Compile(b);

        var x = Assert.Single(net.Crossings);
        Assert.True(x.Implicit);
        Assert.Null(x.OsmId);
        Assert.Equal(CrossingSignalMode.Request, x.SignalMode);
    }

    /// <summary>Signalised crossroads: an east-west primary and a north-south secondary.</summary>
    private static OsmBuilder SignalCross() => new OsmBuilder()
        .Node(1, -200, 0).Node(2, 0, 0, ("highway", "traffic_signals")).Node(3, 200, 0)
        .Node(4, 0, 200).Node(5, 0, -200)
        .Way(10, [1, 2, 3], ("highway", "primary"))
        .Way(11, [4, 2, 5], ("highway", "secondary"));

    [Fact]
    public void Signalised_junction_legs_get_implicit_crosswalks_parallel_to_the_perpendicular_group()
    {
        var net = Compile(SignalCross());
        var junction = net.Nodes.Single(n => n.OsmId == 2);
        var groupOf = net.Connectors.Where(c => c.NodeId == junction.Id).GroupBy(c => c.FromLink).ToDictionary(g => g.Key, g => g.First().SignalGroup);

        Assert.Equal(4, net.Crossings.Count);
        foreach (var x in net.Crossings)
        {
            Assert.True(x.Implicit);
            Assert.Equal(CrossingKind.Signal, x.Kind);
            Assert.Equal(CrossingSignalMode.Parallel, x.SignalMode);
            Assert.Equal(junction.Id, x.NodeId);
            Assert.Equal(2, x.Links.Count);
            var outgoing = net.Links.Single(l => x.Links.Any(c => c.LinkId == l.Id) && l.From == junction.Id);
            var incoming = net.Links.Single(l => x.Links.Any(c => c.LinkId == l.Id) && l.To == junction.Id);
            Assert.Equal(incoming.OppositeLinkId, outgoing.Id);
            Assert.True(x.Links.Single(c => c.LinkId == outgoing.Id).Position < 5);
            Assert.True(incoming.Length - x.Links.Single(c => c.LinkId == incoming.Id).Position < 5);
            // Pedestrians crossing a leg walk with the traffic of the other axis.
            Assert.NotEqual(groupOf[incoming.Id], x.SignalGroup);
            Assert.Contains(x.SignalGroup, groupOf.Values);
        }
    }

    [Fact]
    public void A_mapped_signal_crossing_replaces_the_implicit_crosswalk_of_its_leg()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0, ("highway", "traffic_signals")).Node(3, 200, 0)
            .Node(4, 0, 200).Node(5, 0, -200)
            .Node(6, -12, 0, ("highway", "crossing"), ("crossing", "traffic_signals"))
            .Way(10, [1, 6, 2, 3], ("highway", "primary"))
            .Way(11, [4, 2, 5], ("highway", "secondary"));
        var net = Compile(b);

        Assert.Equal(4, net.Crossings.Count);
        Assert.Single(net.Signals);
        var mapped = Assert.Single(net.Crossings, x => !x.Implicit);
        Assert.Equal(6, mapped.OsmId);
        Assert.Equal(CrossingSignalMode.Parallel, mapped.SignalMode);
        Assert.NotNull(mapped.SignalGroup);
    }

    [Fact]
    public void Crossings_survive_without_signals_and_ids_are_stable()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, -50, 0, ("highway", "crossing"), ("crossing", "zebra"))
            .Node(3, 50, 0, ("highway", "crossing"), ("crossing", "uncontrolled")).Node(4, 200, 0)
            .Way(10, [1, 2, 3, 4], ("highway", "tertiary"));
        var first = Compile(b);
        var second = Compile(b);

        Assert.Equal(["x0", "x1"], first.Crossings.Select(x => x.Id));
        Assert.Equal(first.Crossings.Select(x => (x.OsmId, x.Kind)), second.Crossings.Select(x => (x.OsmId, x.Kind)));
        Assert.Equal([2L, 3L], first.Crossings.Select(x => x.OsmId!.Value));
    }
}
