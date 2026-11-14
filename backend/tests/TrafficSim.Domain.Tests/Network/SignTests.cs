using TrafficSim.Domain.Network;
using TrafficSim.Domain.Network.Compilation;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Domain.Tests.Network;

public class SignRuleTests
{
    [Theory]
    [InlineData("DE:206", SignKinds.Stop)]
    [InlineData("DE:205", SignKinds.GiveWay)]
    [InlineData("DE:205-10", SignKinds.GiveWay)]
    [InlineData("DE:306", SignKinds.PriorityRoad)]
    [InlineData("DE:307", SignKinds.PriorityRoadEnd)]
    [InlineData("DE:2050", SignKinds.None)]
    [InlineData("AT:§52.c.24", SignKinds.Stop)]
    [InlineData("CH:3.02", SignKinds.GiveWay)]
    [InlineData("stop", SignKinds.Stop)]
    [InlineData("give_way", SignKinds.GiveWay)]
    [InlineData("DE:274[50];DE:206", SignKinds.Stop)]
    [InlineData("DE:205,DE:306", SignKinds.GiveWay | SignKinds.PriorityRoad)]
    [InlineData("city_limit", SignKinds.None)]
    [InlineData(null, SignKinds.None)]
    public void Parses_traffic_sign_values(string? value, SignKinds expected) => Assert.Equal(expected, SignRule.ParseTrafficSign(value));

    [Fact]
    public void Node_signs_direction_and_priority_roads()
    {
        Assert.Equal(SignKinds.Stop, SignRule.NodeSigns(OsmTags.Of(("highway", "stop"))));
        Assert.Equal(SignKinds.GiveWay, SignRule.NodeSigns(OsmTags.Of(("traffic_sign", "DE:205"))));
        Assert.True(SignRule.Direction(OsmTags.Of(("traffic_sign:direction", "forward"))));
        Assert.False(SignRule.Direction(OsmTags.Of(("direction", "backward"))));
        Assert.Null(SignRule.Direction(OsmTags.Empty));
        Assert.True(SignRule.IsPriorityRoad(OsmTags.Of(("priority_road", "designated"))));
        Assert.True(SignRule.IsPriorityRoad(OsmTags.Of(("traffic_sign", "DE:306"))));
        Assert.False(SignRule.IsPriorityRoad(OsmTags.Of(("priority_road", "end"))));
        Assert.True(SignRule.Rank(RoadClass.Residential, true) > SignRule.Rank(RoadClass.Primary, false));
    }
}

public class SignCompilerTests
{
    private static RoadNetwork Compile(OsmBuilder b) => NetworkCompiler.Compile(b.Build(), b.Area());

    [Fact]
    public void Signed_priority_road_beats_right_before_left()
    {
        var b = new OsmBuilder()
            .Node(1, -100, 0).Node(2, 0, 0).Node(3, 100, 0).Node(4, 0, 100)
            .Way(10, [1, 2, 3], ("highway", "residential"), ("priority_road", "designated"))
            .Way(11, [2, 4], ("highway", "residential"));
        var net = Compile(b);
        var j = net.Nodes.Single(n => n.OsmId == 2);

        Assert.Equal(NodeControl.Priority, j.Control);
        var side = net.Links.Single(l => l.OsmWayId == 11 && l.To == j.Id);
        Assert.All(net.Connectors.Where(c => c.FromLink == side.Id), c => Assert.Equal(ConnectorPriority.Minor, c.Priority));
        Assert.Equal(EndSign.GiveWay, side.EndSign);
        Assert.All(net.Links.Where(l => l.OsmWayId == 10 && l.To == j.Id), l => Assert.Equal(EndSign.PriorityRoad, l.EndSign));
    }

    [Fact]
    public void Signed_priority_road_wins_over_higher_road_class()
    {
        var b = new OsmBuilder()
            .Node(1, -100, 0).Node(2, 0, 0).Node(3, 100, 0).Node(4, 0, 100).Node(5, 0, -100)
            .Way(10, [1, 2, 3], ("highway", "residential"), ("priority_road", "designated"))
            .Way(11, [4, 2, 5], ("highway", "tertiary"));
        var net = Compile(b);
        var j = net.Nodes.Single(n => n.OsmId == 2).Id;

        Assert.All(net.Connectors.Where(c => c.NodeId == j && net.Links.First(l => l.Id == c.FromLink).OsmWayId == 11),
            c => Assert.NotEqual(ConnectorPriority.Major, c.Priority));
    }

    [Fact]
    public void Traffic_sign_codes_on_approach_nodes()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0).Node(3, 200, 0).Node(4, 0, 200)
            .Node(5, 0, 15, ("traffic_sign", "DE:206"), ("direction", "backward"))
            .Way(10, [1, 2, 3], ("highway", "secondary"))
            .Way(11, [2, 5, 4], ("highway", "residential"));
        var net = Compile(b);
        var j = net.Nodes.Single(n => n.OsmId == 2).Id;

        var southbound = net.Links.Single(l => l.OsmWayId == 11 && l.To == j);
        Assert.All(net.Connectors.Where(c => c.FromLink == southbound.Id), c => Assert.Equal(ConnectorPriority.Stop, c.Priority));
        Assert.Equal(EndSign.Stop, southbound.EndSign);
    }

    [Fact]
    public void Signs_follow_the_road_across_joints_and_unattributable_signs_are_counted()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0).Node(3, 200, 0).Node(4, 0, 200)
            .Node(6, 0, 30) // joint: the side road changes tags here
            .Node(5, 0, 45, ("highway", "give_way"), ("direction", "backward"))
            .Node(7, 0, 150, ("highway", "stop"), ("direction", "forward")) // points away from any junction
            .Way(10, [1, 2, 3], ("highway", "secondary"))
            .Way(11, [2, 6], ("highway", "residential"), ("surface", "asphalt"))
            .Way(12, [6, 5, 7, 4], ("highway", "residential"));
        var net = Compile(b);
        var j = net.Nodes.Single(n => n.OsmId == 2).Id;

        var approach = net.Links.Single(l => l.OsmWayId == 11 && l.To == j);
        Assert.Equal(EndSign.GiveWay, approach.EndSign);
        Assert.Equal(1, net.IgnoredSigns);
    }

    [Fact]
    public void Suppressed_signals_are_not_captured()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0, ("trafficsim:signals", "no")).Node(3, 200, 0).Node(4, 0, 200)
            .Node(5, -20, 0, ("highway", "traffic_signals"))
            .Way(10, [1, 5, 2, 3], ("highway", "primary"))
            .Way(11, [2, 4], ("highway", "residential"));
        var net = Compile(b);

        Assert.Equal(NodeControl.Priority, net.Nodes.Single(n => n.OsmId == 2).Control);
        Assert.Empty(net.Signals);
    }

    [Fact]
    public void Links_carry_their_osm_nodes_in_travel_direction()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, -100, 0).Node(3, 200, 0)
            .Way(10, [1, 2, 3], ("highway", "residential"));
        var net = Compile(b);
        var forward = net.Links.Single(l => l.OsmForward);
        var backward = net.Links.Single(l => !l.OsmForward);

        Assert.Equal([1L, 2L, 3L], forward.OsmNodes.Select(n => n.Id!.Value));
        Assert.Equal([3L, 2L, 1L], backward.OsmNodes.Select(n => n.Id!.Value));
        Assert.Equal(-100, forward.OsmNodes[1].Position.X, 3);
    }
}
