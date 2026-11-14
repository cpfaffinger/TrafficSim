using TrafficSim.Domain.Network;
using TrafficSim.Domain.Network.Compilation;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Domain.Tests.Network;

public class TransitRuleTests
{
    private const OsmMemberType N = OsmMemberType.Node;
    private const OsmMemberType W = OsmMemberType.Way;

    /// <summary>
    /// Main road 1 → 3 → 7 (ways 10 and 11, two-way) crossing the side road 4 → 3 → 5 (way 12) at node 3;
    /// stop position 2 on way 10, platform 8 beside way 11 and road 13 north from node 6 on way 11.
    /// </summary>
    private static OsmBuilder Roads(params (string, string)[] way11Tags)
    {
        var b = new OsmBuilder()
            .Node(1, -250, 0).Node(2, -100, 0, ("public_transport", "stop_position"), ("name", "A")).Node(3, 0, 0)
            .Node(6, 150, 0).Node(7, 250, 0).Node(4, 0, 200).Node(5, 0, -200).Node(9, 150, 200)
            .Node(8, 120, -8, ("public_transport", "platform"), ("highway", "bus_stop"), ("name", "B"), ("bus_bay", "yes"))
            .Node(20, -400, 0);
        b.Way(10, [1, 2, 3], ("highway", "primary"));
        b.Way(11, [3, 6, 7], [("highway", "primary"), .. way11Tags]);
        b.Way(12, [4, 3, 5], ("highway", "residential"));
        b.Way(13, [6, 9], ("highway", "residential"));
        b.Way(14, [20, 1], ("highway", "primary"));
        return b;
    }

    private static (string, string)[] Bus(params (string, string)[] extra) => [("type", "route"), ("route", "bus"), .. extra];

    private static Link LinkOf(RoadNetwork net, long way, bool forward, double? startX = null) =>
        net.Links.Single(l => l.OsmWayId == way && l.OsmForward == forward && (startX is null || Math.Abs(l.OsmNodes[0].Position.X - startX.Value) < 1));

    [Fact]
    public void Maps_a_route_onto_connected_links_with_stops_and_headway()
    {
        var b = Roads().Relation(100, [(N, 2, "stop"), (N, 8, "platform"), (W, 10, ""), (W, 11, "")],
            Bus(("ref", "1"), ("name", "Bus 1"), ("interval", "10"), ("colour", "#ff0000")));

        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        var line = Assert.Single(net.TransitLines);
        var (eb10, eb11a, eb11b) = (LinkOf(net, 10, true), LinkOf(net, 11, true, 0), LinkOf(net, 11, true, 150));
        Assert.Equal([eb10.Id, eb11a.Id, eb11b.Id], line.Links);
        Assert.Equal(("t0", 100L, "1", "Bus 1", "bus", "#ff0000", 600.0), (line.Id, line.OsmId!.Value, line.Ref, line.Name, line.Mode, line.Colour, line.Headway!.Value));
        Assert.Equal(2, line.Stops.Count);
        var a = line.Stops[0];
        Assert.Equal(("t0s0", 2L, "A", eb10.Id, false), (a.Id, a.OsmId!.Value, a.Name, a.LinkId, a.Bay));
        Assert.Equal(150, a.Position, 0.5);
        var stopB = line.Stops[1];
        Assert.Equal(("t0s1", 8L, "B", eb11a.Id, true), (stopB.Id, stopB.OsmId!.Value, stopB.Name, stopB.LinkId, stopB.Bay));
        Assert.Equal(120 - eb11a.Geometry[0].X, stopB.Position, 0.5);
        Assert.Equal(0, net.DroppedTransitLines);
    }

    [Fact]
    public void Orients_ways_listed_against_their_direction()
    {
        var b = Roads().Relation(100, [(W, 11, ""), (W, 10, "")], Bus());

        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        var line = Assert.Single(net.TransitLines);
        Assert.Equal([LinkOf(net, 11, false, 250).Id, LinkOf(net, 11, false, 150).Id, LinkOf(net, 10, false).Id], line.Links);
        Assert.Null(line.Headway);
    }

    [Fact]
    public void Traverses_a_way_partially_and_takes_the_interval_of_the_route_master()
    {
        var b = Roads()
            .Relation(100, [(W, 12, ""), (W, 11, "")], Bus(("ref", "2")))
            .Relation(90, [(OsmMemberType.Relation, 100, "")], ("type", "route_master"), ("interval", "00:12"), ("colour", "blue"));

        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        var line = Assert.Single(net.TransitLines);
        var southbound = net.Links.Single(l => l.OsmWayId == 12 && l.OsmForward && l.OsmNodes[0].Id == 4);
        Assert.Equal([southbound.Id, LinkOf(net, 11, true, 0).Id, LinkOf(net, 11, true, 150).Id], line.Links);
        Assert.Equal(720, line.Headway);
        Assert.Equal("blue", line.Colour);
    }

    [Fact]
    public void Bridges_gaps_inside_the_network()
    {
        // Way 99 is missing; way 13 does not touch way 10: the route continues over way 11 (3 → 6).
        var b = Roads().Relation(100, [(W, 10, ""), (W, 99, ""), (W, 13, "")], Bus());

        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        var line = Assert.Single(net.TransitLines);
        Assert.Equal([LinkOf(net, 10, true).Id, LinkOf(net, 11, true, 0).Id, LinkOf(net, 13, true).Id], line.Links);
    }

    [Fact]
    public void Clipped_route_enters_and_leaves_at_boundary_nodes()
    {
        var b = Roads().Relation(100, [(N, 2, "stop"), (W, 14, ""), (W, 10, ""), (W, 11, "")], Bus());

        var net = NetworkCompiler.Compile(b.Build(), b.Area(200));

        var line = Assert.Single(net.TransitLines);
        var links = line.Links.Select(id => net.Links.Single(l => l.Id == id)).ToList();
        Assert.Equal(3, links.Count);
        Assert.All(links, l => Assert.True(l.OsmForward));
        Assert.Equal(NodeControl.Boundary, net.Nodes.Single(n => n.Id == links[0].From).Control);
        Assert.Equal(NodeControl.Boundary, net.Nodes.Single(n => n.Id == links[^1].To).Control);
        Assert.Equal(100, Assert.Single(line.Stops).Position, 0.5);
    }

    [Fact]
    public void Way_bus_bay_applies_to_the_side_of_the_way()
    {
        var eastbound = Roads(("bus_bay", "right")).Relation(100, [(N, 6, "stop"), (W, 10, ""), (W, 11, "")], Bus());
        var westbound = Roads(("bus_bay", "right")).Relation(100, [(N, 6, "stop"), (W, 11, ""), (W, 10, "")], Bus());

        var east = NetworkCompiler.Compile(eastbound.Build(), eastbound.Area()).TransitLines[0];
        var west = NetworkCompiler.Compile(westbound.Build(), westbound.Area()).TransitLines[0];

        Assert.True(Assert.Single(east.Stops).Bay);
        Assert.False(Assert.Single(west.Stops).Bay);
    }

    [Fact]
    public void Unroutable_routes_are_dropped_and_other_routes_ignored()
    {
        var b = Roads()
            .Relation(100, [(W, 98, ""), (W, 99, "")], Bus())
            .Relation(101, [(W, 10, "")], ("type", "route"), ("route", "tram"));

        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        Assert.Empty(net.TransitLines);
        Assert.Equal(1, net.DroppedTransitLines);
        Assert.Empty(NetworkCompiler.Compile(Roads().Build(), Roads().Area()).TransitLines);
    }

    [Theory]
    [InlineData("10", 600.0)]
    [InlineData("00:12", 720.0)]
    [InlineData("00:10:30", 630.0)]
    [InlineData("5-10", 450.0)]
    [InlineData("0", null)]
    [InlineData("every ten minutes", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void Parses_osm_intervals(string? value, double? seconds) =>
        Assert.Equal(seconds, TransitRule.ParseInterval(value));

    [Fact]
    public void Edits_that_split_ways_keep_route_members_in_order()
    {
        var route = new OsmRelation(1, [new OsmMember(N, 5, "stop"), new OsmMember(W, 10, ""), new OsmMember(W, 11, "")], OsmTags.Of(("type", "route")));
        List<(long, long, IReadOnlyList<long>)> ways = [(11, 11, new long[] { 7, 8 }), (-2, 10, new long[] { 3, 4 }), (10, 10, new long[] { 1, 2, 3 })];

        var result = Assert.Single(TransitRelations.FollowSplits([route], ways));

        Assert.Equal([5L, 10, -2, 11], result.Members.Select(m => m.Ref));
        Assert.Same(route, Assert.Single(TransitRelations.FollowSplits([route], [(10L, 10L, (IReadOnlyList<long>)new long[] { 1, 2 })])));
    }
}
