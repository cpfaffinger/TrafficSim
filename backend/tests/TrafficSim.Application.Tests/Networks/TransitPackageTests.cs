using System.Text.Json;
using TrafficSim.Application.Networks;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Network;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Tests.Networks;

public class TransitPackageTests
{
    private static RoadNetwork Network(params TransitLine[] lines) => new()
    {
        Origin = new GeoPoint(48.2, 16.37),
        Area = new BoundingBox(48.19, 16.36, 48.21, 16.38),
        TransitLines = lines,
        DroppedTransitLines = 2,
    };

    private static string FixturePath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "docs", "architecture", "fixtures")))
        {
            dir = dir.Parent;
        }

        return Path.Combine(dir!.FullName, "docs", "architecture", "fixtures", "network-package-transit-v1.json");
    }

    [Fact]
    public void Writer_adds_transit_lines_and_stats()
    {
        var line = new TransitLine
        {
            Id = "t0",
            OsmId = 100,
            Ref = "13A",
            Name = "Bus 13A",
            Mode = "bus",
            Colour = "#e2001a",
            Headway = 600,
            Links = ["l0", "l1"],
            Stops = [new TransitStop("t0s0", 7, "Oper", "l1", 42.123, Bay: true)],
        };

        var package = NetworkPackageWriter.ToPackage(Network(line), null, ["© OSM"]);
        var json = JsonSerializer.Serialize(package, NetworkPackage.JsonOptions);

        Assert.Contains("\"transitLines\":[{\"id\":\"t0\",\"osmId\":100,\"ref\":\"13A\",\"name\":\"Bus 13A\",\"mode\":\"bus\",\"colour\":\"#e2001a\",\"headway\":600,\"links\":[\"l0\",\"l1\"],"
            + "\"stops\":[{\"id\":\"t0s0\",\"osmId\":7,\"name\":\"Oper\",\"link\":\"l1\",\"pos\":42.12,\"bay\":true}]}]", json, StringComparison.Ordinal);
        Assert.Equal((1, 2), (package.Stats.TransitLines, package.Stats.DroppedTransitLines));
        var back = NetworkPackageWriter.DeserializeGzip(NetworkPackageWriter.SerializeGzip(package));
        Assert.Equal("l1", Assert.Single(Assert.Single(back.TransitLines!).Stops).Link);
    }

    [Fact]
    public void Packages_without_lines_have_no_transit_key()
    {
        var json = JsonSerializer.Serialize(NetworkPackageWriter.ToPackage(Network(), null, []), NetworkPackage.JsonOptions);

        Assert.DoesNotContain("transitLines\":[", json, StringComparison.Ordinal);
    }

    [Fact]
    public void Transit_fixture_deserialises_with_consistent_references()
    {
        var package = JsonSerializer.Deserialize<NetworkPackage>(File.ReadAllText(FixturePath()), NetworkPackage.JsonOptions);

        Assert.NotNull(package?.TransitLines);
        var links = package.Links.ToDictionary(l => l.Id);
        Assert.All(package.TransitLines, line =>
        {
            Assert.All(line.Links, id => Assert.Contains(id, links.Keys));
            Assert.All(line.Links.Zip(line.Links.Skip(1)), p => Assert.Contains(package.Connectors, c => c.FromLink == p.First && c.ToLink == p.Second));
            Assert.All(line.Stops, s => Assert.InRange(s.Pos, 0, links[s.Link].Length));
        });
        Assert.Equal(package.Stats.TransitLines, package.TransitLines.Count);
    }

    [Fact]
    public void Osm_codec_keeps_relations()
    {
        var data = new OsmDataSet(
            [new OsmNode(1, new GeoPoint(48.2, 16.37)), new OsmNode(2, new GeoPoint(48.2, 16.38))],
            [new OsmWay(10, [1, 2], OsmTags.Of(("highway", "primary")))],
            null,
            [new OsmRelation(5, [new OsmMember(OsmMemberType.Node, 1, "stop"), new OsmMember(OsmMemberType.Way, 10, ""), new OsmMember(OsmMemberType.Relation, 4, "x")], OsmTags.Of(("type", "route"), ("route", "bus")))]);

        var back = OsmDataCodec.Decode(OsmDataCodec.Encode(data));

        var relation = Assert.Single(back.Relations);
        Assert.Equal(data.Relations[0].Members, relation.Members);
        Assert.Equal("bus", relation.Tags["route"]);
        Assert.Empty(OsmDataCodec.Decode(OsmDataCodec.Encode(new OsmDataSet([], []))).Relations);
    }
}
