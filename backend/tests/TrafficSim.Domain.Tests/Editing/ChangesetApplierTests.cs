using System.Text.Json;
using TrafficSim.Domain.Editing;
using TrafficSim.Domain.Network;
using TrafficSim.Domain.Network.Compilation;
using TrafficSim.Domain.Osm;
using TrafficSim.Domain.Tests.Network;

namespace TrafficSim.Domain.Tests.Editing;

public class ChangesetApplierTests
{
    // Main road 10: 1 - 2 - 3 - 4 (2 junction at x=0 with side road 11: 5 - 2 - 6), node 3 at x=100.
    private static (OsmDataSet Data, OsmBuilder B) Network()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0).Node(3, 100, 0).Node(4, 200, 0)
            .Node(5, 0, 200).Node(6, 0, -200)
            .Way(10, [1, 2, 3, 4], ("highway", "primary"), ("lanes", "2"))
            .Way(11, [5, 2, 6], ("highway", "residential"));
        return (b.Build(), b);
    }

    private static Dictionary<string, string?> T(params (string Key, string? Value)[] tags) => tags.ToDictionary(t => t.Key, t => t.Value);

    [Fact]
    public void Set_way_tags_on_a_part_splits_the_way()
    {
        var (data, _) = Network();

        var result = ChangesetApplier.Apply(data, [new SetWayTags(10, 2, 3, T(("lanes", "4"), ("name", "New")))]);

        Assert.Empty(result.Issues);
        Assert.Equal(3, result.Data.Ways.Count(w => w.Tags.GetValueOrDefault("highway") == "primary"));
        var part = Assert.Single(result.Data.Ways, w => w.Tags.GetValueOrDefault("lanes") == "4");
        Assert.Equal([2L, 3L], part.NodeIds);
        Assert.Equal("New", part.Tags["name"]);
        Assert.Equal([1L, 2L], result.Data.Ways.Single(w => w.Id == 10).NodeIds);
    }

    [Fact]
    public void Later_edits_find_split_parts_by_original_id()
    {
        var (data, _) = Network();

        var result = ChangesetApplier.Apply(data,
        [
            new SetWayTags(10, 2, 3, T(("lanes", "4"))),
            new SetWayTags(10, 3, 4, T(("maxspeed", "70"))),
            new SetWayTags(10, null, null, T(("name", "Main"), ("lanes", null))),
        ]);

        Assert.Empty(result.Issues);
        Assert.Equal("70", result.Data.Ways.Single(w => w.NodeIds.SequenceEqual([3L, 4L])).Tags["maxspeed"]);
        var first = result.Data.Ways.Single(w => w.Id == 10);
        Assert.Equal("Main", first.Tags["name"]);
        Assert.False(first.Tags.ContainsKey("lanes"));
    }

    [Fact]
    public void Invalid_or_vanished_targets_are_reported_and_skipped()
    {
        var (data, _) = Network();

        var result = ChangesetApplier.Apply(data,
        [
            new SetWayTags(99, null, null, T(("lanes", "2"))),
            new SetWayTags(10, null, null, T(("lanes", "12"))),
            new SetWayTags(10, 5, 6, T(("lanes", "1"))),
            new SetNodeTags(99, T(("highway", "stop"))),
            new SetWayTags(10, null, null, T(("maxspeed", "warp"))),
            new SetWayTags(10, null, null, T(("layer", "9"))),
            new SetNodeTags(2, T(("highway", "teleporter"))),
            new SetSignalPlan(2, 500, 0, [30], null),
            new ConvertToRoundabout(2, 100),
        ]);

        Assert.Equal(Enumerable.Range(0, 9), result.Issues.Select(i => i.OperationIndex));
        Assert.Equal(data.Ways.Count, result.Data.Ways.Count);
        Assert.Contains("not found", result.Issues[0].Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Node_tags_change_junction_control()
    {
        var (data, b) = Network();

        var result = ChangesetApplier.Apply(data, [new SetNodeTags(2, T(("highway", "traffic_signals")))]);
        var net = NetworkCompiler.Compile(result.Data, b.Area(), overrides: result.Overrides);

        Assert.Equal(NodeControl.Signal, net.Nodes.Single(n => n.OsmId == 2).Control);
        Assert.Equal("traffic_signals", result.Data.Nodes[2].Tags["highway"]);
    }

    [Fact]
    public void Add_way_with_new_nodes_connects_to_existing_junction_and_can_be_a_bridge()
    {
        var (data, b) = Network();
        var far = data.Nodes[4].Location;

        var result = ChangesetApplier.Apply(data,
        [
            new AddWay(-1, [new WayNode(3), new WayNode(-10, far.Latitude + 0.001, far.Longitude)], new Dictionary<string, string> { ["highway"] = "secondary", ["bridge"] = "yes" }),
            new InsertNode(11, 5, -11, data.Nodes[5].Location.Latitude - 0.0005, data.Nodes[5].Location.Longitude),
            new AddWay(-2, [new WayNode(-11), new WayNode(-12, data.Nodes[5].Location.Latitude - 0.0005, data.Nodes[5].Location.Longitude + 0.001)], new Dictionary<string, string> { ["highway"] = "residential" }),
        ]);
        var net = NetworkCompiler.Compile(result.Data, b.Area(400), overrides: result.Overrides);

        Assert.Empty(result.Issues);
        Assert.Contains(net.Links, l => l.OsmWayId == -1 && l.Structure == Structure.Bridge);
        Assert.NotEqual(NodeControl.None, net.Nodes.Single(n => n.OsmId == 3).Control);
        Assert.Contains(net.Nodes, n => n.OsmId == -11 && n.Control != NodeControl.None);
    }

    [Fact]
    public void Add_way_validation()
    {
        var (data, _) = Network();
        var tags = new Dictionary<string, string> { ["highway"] = "residential" };

        var result = ChangesetApplier.Apply(data,
        [
            new AddWay(5, [new WayNode(1), new WayNode(2)], tags),
            new AddWay(-1, [new WayNode(1)], tags),
            new AddWay(-2, [new WayNode(1), new WayNode(2)], new Dictionary<string, string> { ["highway"] = "footway" }),
            new AddWay(-3, [new WayNode(1), new WayNode(-9)], tags),
            new AddWay(-4, [new WayNode(1), new WayNode(2)], new Dictionary<string, string> { ["highway"] = "primary", ["lanes"] = "x" }),
            new InsertNode(10, 4, -20, 0, 0),
            new InsertNode(10, 1, 7, 0, 0),
        ]);

        Assert.Equal(7, result.Issues.Count);
    }

    [Fact]
    public void Remove_way_part()
    {
        var (data, b) = Network();

        var result = ChangesetApplier.Apply(data, [new RemoveWay(10, 3, 4), new RemoveWay(11, null, null)]);
        var net = NetworkCompiler.Compile(result.Data, b.Area(), overrides: result.Overrides);

        Assert.Empty(result.Issues);
        Assert.Equal([1L, 2L, 3L], Assert.Single(result.Data.Ways).NodeIds);
        Assert.Equal(2, net.Links.Count);
        Assert.False(result.Data.Nodes.ContainsKey(5));
    }

    [Fact]
    public void Convert_junction_to_roundabout()
    {
        var (data, b) = Network();

        var result = ChangesetApplier.Apply(data, [new ConvertToRoundabout(2, 15)]);
        var net = NetworkCompiler.Compile(result.Data, b.Area(), overrides: result.Overrides);

        Assert.Empty(result.Issues);
        var ring = Assert.Single(result.Data.Ways, w => w.Tags.GetValueOrDefault("junction") == "roundabout");
        Assert.Equal(ring.NodeIds[0], ring.NodeIds[^1]);
        Assert.Equal("primary", ring.Tags["highway"]);
        Assert.DoesNotContain(result.Data.Ways, w => w.NodeIds.Contains(2));
        Assert.Equal(4, net.Nodes.Count(n => n.Control == NodeControl.Roundabout));
        Assert.Contains(net.Connectors, c => c.Priority == ConnectorPriority.RoundaboutEntry);
    }

    [Fact]
    public void Lane_connection_overrides_and_bans_shape_connectors()
    {
        var (data, b) = Network();

        var result = ChangesetApplier.Apply(data,
        [
            new BanMovement(2, 1, 5),                    // eastbound main → northbound side street: banned
            new SetLaneConnections(2, 1, 0, 3, [0]),     // eastbound through: only lane 0 → lane 0
            new SetLaneConnections(2, 1, 1, 3, []),
            new SetLaneConnections(2, 3, 0, 1, [0, 1]),
            new BanMovement(2, 3, 1),                     // ban replaces the mapping above
            new SetLaneConnections(99, 1, 0, 3, [0]),
            new SetLaneConnections(2, 1, -1, 3, [0]),
            new BanMovement(99, 1, 5),
        ]);
        var net = NetworkCompiler.Compile(result.Data, b.Area(), overrides: result.Overrides);
        var junction = net.Nodes.Single(n => n.OsmId == 2).Id;
        var east = net.Links.Single(l => l.To == junction && l.Geometry[0].X < -100);
        var west = net.Links.Single(l => l.To == junction && l.Geometry[0].X > 50);
        var north = net.Links.Single(l => l.From == junction && l.Geometry[^1].Y > 100);

        Assert.Equal(3, result.Issues.Count);
        Assert.DoesNotContain(net.Connectors, c => c.FromLink == east.Id && c.ToLink == north.Id);
        Assert.Equal([(0, 0)], net.Connectors.Where(c => c.FromLink == east.Id && c.Turn == Turn.Through).Select(c => (c.FromLane, c.ToLane)));
        Assert.DoesNotContain(net.Connectors, c => c.FromLink == west.Id && c.Turn == Turn.Through);
    }

    [Fact]
    public void Signal_plan_override_sets_timing_and_phase_assignment()
    {
        var (data, b) = Network();

        var result = ChangesetApplier.Apply(data,
        [
            new SetNodeTags(2, T(("highway", "traffic_signals"))),
            new SetSignalPlan(2, 60, 7, [20, 10, 8], new Dictionary<long, int> { [5] = 2, [6] = 9 }),
        ]);
        var net = NetworkCompiler.Compile(result.Data, b.Area(), overrides: result.Overrides);
        var signal = Assert.Single(net.Signals);
        var southbound = net.Links.Single(l => l.To == signal.NodeId && l.Geometry[0].Y > 100);
        var northbound = net.Links.Single(l => l.To == signal.NodeId && l.Geometry[0].Y < -100);

        Assert.Equal(60, signal.Cycle);
        Assert.Equal(7, signal.Offset);
        Assert.Equal(3, signal.Groups.Count);
        Assert.Equal(new GreenInterval(25, 35), signal.Groups[1].Green[0]);
        Assert.All(net.Connectors.Where(c => c.FromLink == southbound.Id), c => Assert.EndsWith(":g2", c.SignalGroup, StringComparison.Ordinal));
        Assert.All(net.Connectors.Where(c => c.FromLink == northbound.Id), c => Assert.EndsWith(":g2", c.SignalGroup, StringComparison.Ordinal));
    }

    [Fact]
    public void Operations_serialise_with_an_op_discriminator()
    {
        EditOperation[] ops =
        [
            new SetWayTags(10, 2, null, T(("lanes", "3"))),
            new ConvertToRoundabout(2, 12),
            new SetSignalPlan(2, 90, 0, [40, 40], new Dictionary<long, int> { [1] = 0 }),
        ];

        var json = JsonSerializer.Serialize(ops, JsonSerializerOptions.Web);
        var back = JsonSerializer.Deserialize<EditOperation[]>(json, JsonSerializerOptions.Web);

        Assert.Contains("\"op\":\"set_way_tags\"", json, StringComparison.Ordinal);
        Assert.Contains("\"op\":\"convert_to_roundabout\"", json, StringComparison.Ordinal);
        Assert.Equal(12, Assert.IsType<ConvertToRoundabout>(back![1]).Radius);
        Assert.Equal(0, Assert.IsType<SetSignalPlan>(back[2]).ApproachPhase![1]);
    }
}
