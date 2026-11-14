using System.Text.Json;
using TrafficSim.Application.Networks;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Network;

namespace TrafficSim.Application.Tests.Networks;

public class NetworkPackageTests
{
    private static string GoldenPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "docs", "architecture", "fixtures")))
        {
            dir = dir.Parent;
        }

        return Path.Combine(dir!.FullName, "docs", "architecture", "fixtures", "network-package-v1.json");
    }

    [Fact]
    public void Golden_fixture_deserialises_into_the_v1_contract()
    {
        var package = JsonSerializer.Deserialize<NetworkPackage>(File.ReadAllText(GoldenPath()), NetworkPackage.JsonOptions);

        Assert.NotNull(package);
        Assert.Equal(1, package.FormatVersion);
        Assert.Equal(package.Stats.Links, package.Links.Count);
        Assert.Equal(package.Stats.Connectors, package.Connectors.Count);
        var linkIds = package.Links.Select(l => l.Id).ToHashSet();
        var nodeIds = package.Nodes.Select(n => n.Id).ToHashSet();
        Assert.All(package.Links, l =>
        {
            Assert.Contains(l.From, nodeIds);
            Assert.Contains(l.To, nodeIds);
            Assert.Equal(l.Lanes.Count - 1, l.Boundaries.Count);
            Assert.All(l.Geometry, p => Assert.Equal(3, p.Length));
        });
        Assert.All(package.Connectors, c =>
        {
            Assert.Contains(c.FromLink, linkIds);
            Assert.Contains(c.ToLink, linkIds);
        });
        Assert.Contains(package.Links, l => l.Structure == "bridge" && l.Layer == 1);
        Assert.Contains(package.Links.SelectMany(l => l.Boundaries), b => b.Marking == "solid_dashed");
    }

    [Fact]
    public void Writer_maps_domain_to_snake_case_contract_and_round_trips_gzip()
    {
        var network = new RoadNetwork
        {
            Origin = new GeoPoint(48.2, 16.37),
            Area = new BoundingBox(48.19, 16.36, 48.21, 16.38),
            OsmTimestamp = DateTimeOffset.UnixEpoch,
            Nodes = [new NetworkNode { Id = "n0", OsmId = 1, Position = new Vec3(1.23456, 2, 0), Control = NodeControl.RightBeforeLeft }],
            Links =
            [
                new Link
                {
                    Id = "l0", From = "n0", To = "n0", RoadClass = RoadClass.MotorwayLink, Structure = Structure.Bridge, LeftEdge = EdgeMarking.CentreDashed,
                    Geometry = [new Vec3(0, 0), new Vec3(10, 0)],
                    Lanes = [new Lane { LinkId = "l0", Index = 0, Allowed = VehicleClasses.Car | VehicleClasses.Bus, Turns = TurnMarkings.Through | TurnMarkings.SlightRight, Geometry = [new Vec3(0, -1), new Vec3(10, -1)] }],
                    Boundaries = [new LaneBoundary(0, true, false)],
                },
            ],
            Connectors = [new Connector { Id = "c0", NodeId = "n0", FromLink = "l0", FromLane = 0, ToLink = "l0", ToLane = 0, Turn = Turn.SlightLeft, Priority = ConnectorPriority.RoundaboutEntry, Geometry = [new Vec3(0, 0), new Vec3(1, 1)] }],
            Signals = [new SignalController("n0", 90, 0, [new SignalGroup("n0:g0", [new GreenInterval(0, 40)], 3)])],
        };

        var package = NetworkPackageWriter.ToPackage(network, Guid.Empty, ["© OSM"]);
        var json = JsonSerializer.Serialize(package, NetworkPackage.JsonOptions);
        var roundTrip = NetworkPackageWriter.DeserializeGzip(NetworkPackageWriter.SerializeGzip(package));

        Assert.Contains("\"control\":\"right_before_left\"", json, StringComparison.Ordinal);
        Assert.Contains("\"roadClass\":\"motorway_link\"", json, StringComparison.Ordinal);
        Assert.Contains("\"allowed\":[\"car\",\"bus\"]", json, StringComparison.Ordinal);
        Assert.Contains("\"turns\":[\"through\",\"slight_right\"]", json, StringComparison.Ordinal);
        Assert.Contains("\"marking\":\"solid_dashed\"", json, StringComparison.Ordinal);
        Assert.Contains("\"priority\":\"roundabout_entry\"", json, StringComparison.Ordinal);
        Assert.Contains("\"leftEdge\":\"centre_dashed\"", json, StringComparison.Ordinal);
        Assert.Contains("\"x\":1.235", json, StringComparison.Ordinal);
        Assert.Equal(package.Stats, roundTrip.Stats);
        Assert.Equal(1, roundTrip.Links[0].Boundaries[0].LeftLane);
        Assert.Equal([0.0, 40.0], roundTrip.Signals[0].Groups[0].Green[0]);
        Assert.Contains("\"crossings\":[]", json, StringComparison.Ordinal);
    }

    [Fact]
    public void Writer_maps_crossings()
    {
        var network = new RoadNetwork
        {
            Origin = new GeoPoint(48.2, 16.37),
            Area = new BoundingBox(48.19, 16.36, 48.21, 16.38),
            Crossings =
            [
                new Crossing
                {
                    Id = "x0", OsmId = 5, Kind = CrossingKind.Signal, NodeId = "n1", SignalGroup = "n1:g0", SignalMode = CrossingSignalMode.Request,
                    Width = 7.00012, Depth = 4, Demand = 120, Geometry = [new Vec3(0, -3.5), new Vec3(0, 3.5)],
                    Links = [new CrossingLink("l0", 100, 0, 3.5), new CrossingLink("l1", 100, 3.5, 7)],
                },
                new Crossing { Id = "x1", Kind = CrossingKind.Zebra, Implicit = true, Width = 3, Depth = 3, Geometry = [new Vec3(0, 0), new Vec3(0, 3)], Links = [new CrossingLink("l0", 10, 0, 3)] },
            ],
        };

        var package = NetworkPackageWriter.ToPackage(network, null, []);
        var json = JsonSerializer.Serialize(package, NetworkPackage.JsonOptions);
        var roundTrip = NetworkPackageWriter.DeserializeGzip(NetworkPackageWriter.SerializeGzip(package));

        Assert.Contains("\"kind\":\"signal\"", json, StringComparison.Ordinal);
        Assert.Contains("\"signalMode\":\"request\"", json, StringComparison.Ordinal);
        Assert.Contains("\"span\":[3.5,7]", json, StringComparison.Ordinal);
        Assert.Contains("\"width\":7", json, StringComparison.Ordinal);
        var x1 = roundTrip.Crossings![1];
        Assert.Equal("zebra", x1.Kind);
        Assert.Null(x1.SignalMode);
        Assert.True(x1.Implicit);
        Assert.Equal("l1", roundTrip.Crossings[0].Links[1].Link);
    }
}
