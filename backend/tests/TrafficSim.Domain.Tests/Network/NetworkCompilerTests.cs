using TrafficSim.Domain.Network;
using TrafficSim.Domain.Network.Compilation;

namespace TrafficSim.Domain.Tests.Network;

public class NetworkCompilerTests
{
    /// <summary>A + junction: main road E-W (2 lanes per direction, signals), side road N-S.</summary>
    private static (RoadNetwork Net, OsmBuilder B) Cross(params (string, string)[] mainTags)
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0).Node(3, 200, 0)
            .Node(4, 0, 200).Node(5, 0, -200)
            .Node(6, -20, 0, ("highway", "traffic_signals"));
        var tags = new List<(string, string)> { ("highway", "primary"), ("lanes", "4"), ("name", "Main") };
        tags.AddRange(mainTags);
        b.Way(10, [1, 6, 2, 3], [.. tags]);
        b.Way(11, [4, 2, 5], ("highway", "residential"));
        return (NetworkCompiler.Compile(b.Build(), b.Area()), b);
    }

    [Fact]
    public void Cross_junction_splits_ways_into_directed_links()
    {
        var (net, _) = Cross();

        Assert.Equal(5, net.Nodes.Count);
        Assert.Equal(8, net.Links.Count);
        var junction = Assert.Single(net.Nodes, n => n.OsmId == 2);
        Assert.Equal(NodeControl.Signal, junction.Control);
        Assert.All(net.Nodes.Where(n => n.OsmId != 2), n => Assert.Equal(NodeControl.None, n.Control));
        var eastbound = net.Links.Single(l => l.To == junction.Id && l.Geometry[0].X < -100);
        Assert.Equal(2, eastbound.Lanes.Count);
        Assert.Equal("Main", eastbound.Name);
        Assert.NotNull(eastbound.OppositeLinkId);
        Assert.True(eastbound.OsmForward);
        Assert.False(net.Links.Single(l => l.Id == eastbound.OppositeLinkId).OsmForward);
        Assert.Equal(30, eastbound.NoLaneChangeZone);
        Assert.Contains("speedLimit", eastbound.Assumed);
        Assert.Equal(EdgeMarking.CentreSolid, eastbound.LeftEdge);
        Assert.Equal(LaneMarking.Dashed, Assert.Single(eastbound.Boundaries).Marking);
        // lane 0 is the rightmost: further south for an eastbound link
        Assert.True(eastbound.Lanes[0].Geometry[0].Y < eastbound.Lanes[1].Geometry[0].Y);
        Assert.True(eastbound.Lanes[1].Geometry[0].Y < 0);
        // trimmed at the junction
        Assert.True(eastbound.Geometry[^1].X < -3);
    }

    /// <summary>Seconds of the cycle in which <paramref name="group"/> shows green.</summary>
    private static HashSet<int> GreenSeconds(RoadNetwork net, string group)
    {
        var controller = net.Signals.Single(s => s.Groups.Any(g => g.Id == group));
        var g = controller.Groups.Single(x => x.Id == group);
        return Enumerable.Range(0, (int)controller.Cycle)
            .Where(t => g.Green.Any(i => t >= i.Start && t < i.End))
            .Select(t => (int)((t + controller.Offset) % controller.Cycle))
            .ToHashSet();
    }

    [Fact]
    public void Signal_nodes_of_one_junction_run_a_coordinated_plan()
    {
        // #117: a side road crossing a dual carriageway (carriageways 16 m apart): OSM has a
        // signal node on each carriageway, linked by short side-road links.
        var b = new OsmBuilder()
            .Node(1, -200, -8).Node(21, 0, -8, ("highway", "traffic_signals")).Node(3, 200, -8)
            .Node(6, 200, 8).Node(22, 0, 8, ("highway", "traffic_signals")).Node(8, -200, 8)
            .Node(4, 0, 200).Node(5, 0, -200)
            .Way(10, [1, 21, 3], ("highway", "primary"), ("oneway", "yes"), ("lanes", "2"))
            .Way(11, [6, 22, 8], ("highway", "primary"), ("oneway", "yes"), ("lanes", "2"))
            .Way(12, [4, 22, 21, 5], ("highway", "secondary"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());
        var south = net.Nodes.Single(n => n.OsmId == 21).Id;
        var north = net.Nodes.Single(n => n.OsmId == 22).Id;
        Assert.Equal(2, net.Signals.Count);

        HashSet<int> Approach(string node, Func<Link, bool> from) =>
            GreenSeconds(net, net.Connectors.First(c => c.NodeId == node && from(net.Links.Single(l => l.Id == c.FromLink))).SignalGroup!);
        // Both carriageways share one phase, the side road the other one at both nodes.
        var eastbound = Approach(south, l => l.OsmWayId == 10);
        var westbound = Approach(north, l => l.OsmWayId == 11);
        Assert.Equal(eastbound, westbound);
        var fromNorth = Approach(north, l => l.OsmWayId == 12);
        var fromSouth = Approach(south, l => l.OsmWayId == 12 && l.From != north);
        Assert.Equal(fromNorth, fromSouth);
        Assert.Empty(fromNorth.Intersect(eastbound));

        // Vehicles never have to stop on the short links between the nodes: the movements out of
        // such a link are green whenever a movement into it is.
        var inner = net.Links.Where(l => l.OsmWayId == 12 && new[] { l.From, l.To }.All(n => n == north || n == south)).ToList();
        Assert.Equal(2, inner.Count);
        Assert.All(inner, l => Assert.True(l.Length < 10, $"{l.Length}"));
        foreach (var link in inner)
        {
            foreach (var into in net.Connectors.Where(c => c.ToLink == link.Id))
            {
                foreach (var outOf in net.Connectors.Where(c => c.FromLink == link.Id && c.FromLane == into.ToLane))
                {
                    Assert.Subset(GreenSeconds(net, outOf.SignalGroup!), GreenSeconds(net, into.SignalGroup!));
                }
            }
        }
    }

    [Fact]
    public void Signalised_junction_gets_connectors_conflicts_and_two_phase_plan()
    {
        var (net, _) = Cross();
        var junction = net.Nodes.Single(n => n.OsmId == 2);

        var connectors = net.Connectors.Where(c => c.NodeId == junction.Id).ToList();
        Assert.All(connectors, c => Assert.Equal(ConnectorPriority.Signal, c.Priority));
        Assert.DoesNotContain(connectors, c => c.Turn == Turn.Reverse);
        var signal = Assert.Single(net.Signals);
        Assert.Equal(2, signal.Groups.Count);
        Assert.Equal(90, signal.Cycle);
        var mainGroup = connectors.First(c => net.Links.First(l => l.Id == c.FromLink).RoadClass == RoadClass.Primary).SignalGroup;
        var sideGroup = connectors.First(c => net.Links.First(l => l.Id == c.FromLink).RoadClass == RoadClass.Residential).SignalGroup;
        Assert.NotEqual(mainGroup, sideGroup);
        // eastbound left turn conflicts with westbound through
        var east = net.Links.Single(l => l.To == junction.Id && l.Geometry[0].X < -100);
        var west = net.Links.Single(l => l.To == junction.Id && l.Geometry[0].X > 100);
        var left = connectors.First(c => c.FromLink == east.Id && c.Turn == Turn.Left);
        Assert.Equal(1, left.FromLane);
        var oncoming = connectors.Where(c => c.FromLink == west.Id && c.Turn == Turn.Through);
        Assert.Contains(oncoming, c => left.Conflicts.Contains(c.Id));
        Assert.Contains(connectors, c => c.FromLink == east.Id && c.Turn == Turn.Right && c.FromLane == 0);
        Assert.Equal(2, connectors.Count(c => c.FromLink == east.Id && c.Turn == Turn.Through));
    }

    [Fact]
    public void Turn_lane_markings_select_source_lanes()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0).Node(3, 200, 0).Node(4, 0, 200)
            .Way(10, [1, 2], ("highway", "primary"), ("oneway", "yes"), ("turn:lanes", "left|through|through;right"))
            .Way(11, [2, 3], ("highway", "primary"), ("oneway", "yes"), ("lanes", "2"))
            .Way(12, [2, 4], ("highway", "secondary"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        var approach = net.Links.Single(l => l.OsmWayId == 10);
        Assert.Equal(3, approach.Lanes.Count);
        Assert.Equal(TurnMarkings.Left, approach.Lanes[2].Turns);
        var fromApproach = net.Connectors.Where(c => c.FromLink == approach.Id).ToList();
        Assert.Equal([2], fromApproach.Where(c => c.Turn == Turn.Left).Select(c => c.FromLane));
        Assert.Equal([0, 1], fromApproach.Where(c => c.Turn == Turn.Through).Select(c => c.FromLane).Order());
        Assert.Equal(NodeControl.Priority, net.Nodes.Single(n => n.OsmId == 2).Control);
    }

    [Fact]
    public void Priority_junction_major_road_has_right_of_way()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0).Node(3, 200, 0).Node(4, 0, 200).Node(5, 0, 20, ("highway", "stop"))
            .Way(10, [1, 2, 3], ("highway", "secondary"))
            .Way(11, [4, 5, 2], ("highway", "residential"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());
        var j = net.Nodes.Single(n => n.OsmId == 2).Id;

        var main = net.Connectors.Where(c => c.NodeId == j && net.Links.First(l => l.Id == c.FromLink).OsmWayId == 10).ToList();
        Assert.Contains(main, c => c.Priority == ConnectorPriority.Major && c.Turn == Turn.Through);
        Assert.All(main.Where(c => c.Turn == Turn.Left), c => Assert.Equal(ConnectorPriority.Minor, c.Priority));
        var side = net.Connectors.Where(c => c.NodeId == j && net.Links.First(l => l.Id == c.FromLink).OsmWayId == 11);
        // the stop sign is 20 m before the junction on the southbound approach
        Assert.All(side, c => Assert.Equal(ConnectorPriority.Stop, c.Priority));
    }

    [Fact]
    public void Equal_minor_streets_use_right_before_left()
    {
        var b = new OsmBuilder()
            .Node(1, -100, 0).Node(2, 0, 0).Node(3, 100, 0).Node(4, 0, 100)
            .Way(10, [1, 2, 3], ("highway", "residential"))
            .Way(11, [2, 4], ("highway", "residential"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        Assert.Equal(NodeControl.RightBeforeLeft, net.Nodes.Single(n => n.OsmId == 2).Control);
        Assert.All(net.Connectors.Where(c => c.NodeId == net.Nodes.Single(n => n.OsmId == 2).Id), c => Assert.Equal(ConnectorPriority.RightBeforeLeft, c.Priority));
    }

    [Fact]
    public void All_way_stop_and_level_crossing()
    {
        var b = new OsmBuilder()
            .Node(1, -100, 0).Node(2, 0, 0, ("highway", "stop"), ("stop", "all")).Node(3, 100, 0).Node(4, 0, 100)
            .Node(5, 50, 0, ("railway", "level_crossing"))
            .Way(10, [1, 2, 5, 3], ("highway", "tertiary"))
            .Way(11, [2, 4], ("highway", "tertiary"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        Assert.Equal(NodeControl.AllWayStop, net.Nodes.Single(n => n.OsmId == 2).Control);
        Assert.Equal(NodeControl.LevelCrossing, net.Nodes.Single(n => n.OsmId == 5).Control);
        Assert.All(net.Connectors.Where(c => c.NodeId == net.Nodes.Single(n => n.OsmId == 5).Id), c => Assert.Equal(ConnectorPriority.Stop, c.Priority));
    }

    [Fact]
    public void Roundabout_ring_is_one_way_and_entries_yield()
    {
        var b = new OsmBuilder()
            .Node(1, 20, 0).Node(2, 0, 20).Node(3, -20, 0).Node(4, 0, -20)
            .Node(11, 150, 0).Node(13, -150, 0)
            .Way(100, [1, 2, 3, 4, 1], ("highway", "secondary"), ("junction", "roundabout"))
            .Way(101, [11, 1], ("highway", "secondary"))
            .Way(103, [13, 3], ("highway", "secondary"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        var ring = net.Links.Where(l => l.Roundabout).ToList();
        Assert.NotEmpty(ring);
        Assert.Null(ring[0].OppositeLinkId);
        var entryNode = net.Nodes.Single(n => n.OsmId == 1);
        Assert.Equal(NodeControl.Roundabout, entryNode.Control);
        var atEntry = net.Connectors.Where(c => c.NodeId == entryNode.Id).ToList();
        Assert.Contains(atEntry, c => c.Priority == ConnectorPriority.RoundaboutEntry);
        Assert.Contains(atEntry, c => c.Priority == ConnectorPriority.RoundaboutRing);
        // entering vehicles conflict with ring traffic continuing past the entry
        var entry = atEntry.First(c => c.Priority == ConnectorPriority.RoundaboutEntry);
        Assert.NotEmpty(entry.Conflicts);
    }

    [Fact]
    public void Mini_roundabout_node()
    {
        var b = new OsmBuilder()
            .Node(1, -100, 0).Node(2, 0, 0, ("highway", "mini_roundabout")).Node(3, 100, 0).Node(4, 0, 100)
            .Way(10, [1, 2, 3], ("highway", "residential"))
            .Way(11, [2, 4], ("highway", "residential"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        Assert.Equal(NodeControl.Roundabout, net.Nodes.Single(n => n.OsmId == 2).Control);
        Assert.All(net.Connectors.Where(c => c.NodeId == net.Nodes.Single(n => n.OsmId == 2).Id), c => Assert.Equal(ConnectorPriority.RoundaboutEntry, c.Priority));
    }

    [Fact]
    public void Bridge_over_street_forms_no_junction_and_is_elevated()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 50).Node(2, -60, 50).Node(3, 60, 50).Node(4, 200, 50)
            .Node(5, 0, -200).Node(6, 0, 200)
            .Way(20, [1, 2], ("highway", "motorway"))
            .Way(21, [2, 3], ("highway", "motorway"), ("bridge", "yes"), ("layer", "1"))
            .Way(22, [3, 4], ("highway", "motorway"))
            .Way(30, [5, 6], ("highway", "residential"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        var bridge = net.Links.Single(l => l.OsmWayId == 21);
        Assert.Equal(Structure.Bridge, bridge.Structure);
        Assert.Equal(1, bridge.Layer);
        Assert.Equal(0, net.Nodes.Single(n => n.OsmId == 2).Position.Z);
        Assert.InRange(Polyline.PointAt(bridge.Lanes[0].Geometry, 60).Z, 5.9, 6.01);
        var street = net.Links.Where(l => l.OsmWayId == 30).ToList();
        Assert.Equal(2, street.Count);
        Assert.All(street, l => Assert.DoesNotContain(net.Connectors, c => c.FromLink == l.Id && net.Links.First(o => o.Id == c.ToLink).OsmWayId != 30));
        Assert.DoesNotContain(net.Connectors, c => net.Links.First(l => l.Id == c.FromLink).OsmWayId == 21 && net.Links.First(l => l.Id == c.ToLink).OsmWayId == 30);
        Assert.Equal(2, bridge.Lanes.Count); // motorway default, one-way
        Assert.Equal(EdgeMarking.Edge, bridge.LeftEdge);
    }

    [Fact]
    public void Ways_are_clipped_to_the_area_with_boundary_nodes()
    {
        var b = new OsmBuilder()
            .Node(1, -500, 0).Node(2, 0, 0).Node(3, 500, 0)
            .Way(10, [1, 2, 3], ("highway", "primary"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area(100));

        var boundaries = net.Nodes.Where(n => n.Control == NodeControl.Boundary).ToList();
        Assert.Equal(2, boundaries.Count);
        Assert.All(boundaries, n => Assert.InRange(Math.Abs(n.Position.X), 99, 101));
        Assert.DoesNotContain(net.Connectors, c => boundaries.Any(n => n.Id == c.NodeId));
        Assert.Equal(2, net.Links.Count); // one clipped piece, two directions
    }

    [Fact]
    public void Lane_change_markings_flow_into_boundaries()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 200, 0)
            .Way(10, [1, 2], ("highway", "primary"), ("oneway", "yes"), ("lanes", "2"), ("change:lanes", "not_right|no"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        var link = Assert.Single(net.Links);
        var boundary = Assert.Single(link.Boundaries);
        Assert.False(boundary.AllowLeft);
        Assert.False(boundary.AllowRight);
        Assert.Equal(LaneMarking.Solid, boundary.Marking);
    }

    [Fact]
    public void Restricted_ways_are_skipped_or_flagged()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0).Node(3, 200, 0).Node(4, 0, 200)
            .Way(10, [1, 2], ("highway", "residential"), ("motor_vehicle", "no"))
            .Way(11, [2, 3], ("highway", "residential"), ("access", "destination"), ("bus:lanes:forward", "designated"))
            .Way(12, [2, 4], ("highway", "footway"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());

        Assert.DoesNotContain(net.Links, l => l.OsmWayId is 10 or 12);
        var forward = net.Links.Single(l => l.OsmWayId == 11 && l.Geometry[0].X < l.Geometry[^1].X);
        Assert.False(forward.ThroughTraffic);
        Assert.Equal(VehicleClasses.Bus, forward.Lanes[0].Allowed);
    }

    [Fact]
    public void Dead_end_allows_turning_around()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0).Node(3, 100, 0)
            .Node(4, 0, 100)
            .Way(10, [1, 2], ("highway", "residential"))
            .Way(11, [2, 3], ("highway", "residential"))
            .Way(12, [2, 4], ("highway", "residential"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());
        var deadEnd = net.Nodes.Single(n => n.OsmId == 3);

        var uTurn = Assert.Single(net.Connectors, c => c.NodeId == deadEnd.Id);
        Assert.Equal(Turn.Reverse, uTurn.Turn);
    }

    [Fact]
    public void Motorway_on_ramp_merges_into_the_rightmost_lane()
    {
        var b = new OsmBuilder()
            .Node(1, -250, 0).Node(2, 0, 0).Node(3, 250, 0).Node(4, -200, -60)
            .Way(10, [1, 2], ("highway", "motorway"), ("lanes", "2"))
            .Way(11, [2, 3], ("highway", "motorway"), ("lanes", "3"))
            .Way(12, [4, 2], ("highway", "motorway_link"), ("oneway", "yes"));
        var net = NetworkCompiler.Compile(b.Build(), b.Area());
        var main = net.Links.Single(l => l.OsmWayId == 10);
        var ramp = net.Links.Single(l => l.OsmWayId == 12);

        Assert.Equal([(0, 1), (1, 2)], net.Connectors.Where(c => c.FromLink == main.Id).Select(c => (c.FromLane, c.ToLane)).Order());
        var rampConnector = Assert.Single(net.Connectors, c => c.FromLink == ramp.Id);
        Assert.Equal(0, rampConnector.ToLane);
        Assert.Equal(ConnectorPriority.Minor, rampConnector.Priority);
    }

    [Fact]
    public void Compilation_is_deterministic()
    {
        var (a, _) = Cross();
        var (b, _) = Cross();

        Assert.Equal(a.Links.Select(l => (l.Id, l.From, l.To, l.Length)), b.Links.Select(l => (l.Id, l.From, l.To, l.Length)));
        Assert.Equal(a.Connectors.Select(c => (c.Id, c.FromLink, c.ToLink, string.Join(',', c.Conflicts))), b.Connectors.Select(c => (c.Id, c.FromLink, c.ToLink, string.Join(',', c.Conflicts))));
    }
}
