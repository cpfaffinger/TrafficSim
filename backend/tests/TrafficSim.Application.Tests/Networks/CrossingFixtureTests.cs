using System.Text.Json;
using TrafficSim.Application.Networks;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Network.Compilation;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Tests.Networks;

/// <summary>
/// Cross-stack contract for pedestrian crossings (ADR-0020): a compiled package with every crossing kind,
/// read by the sim core (sim-core/tests/crossings_contract.rs) and the frontend parser.
/// </summary>
public class CrossingFixtureTests
{
    private static string FixtureDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "docs", "architecture", "fixtures")))
        {
            dir = dir.Parent;
        }

        return Path.Combine(dir!.FullName, "docs", "architecture", "fixtures");
    }

    /// <summary>
    /// Signalised crossroads (primary east-west, secondary north-south, clipped at the area edge) with a zebra crossing on the west
    /// arm, an uncontrolled crossing on the north arm and a push-button signal on the east arm.
    /// </summary>
    internal static NetworkPackage Package()
    {
        var origin = new GeoPoint(48.2082, 16.3738);
        var plane = new LocalTangentPlane(origin);
        OsmNode N(long id, double x, double y, params (string, string)[] tags) => new(id, plane.ToGeo(new LocalPoint(x, y)), OsmTags.Of(tags));
        var nodes = new[]
        {
            N(1, -400, 0), N(2, 0, 0, ("highway", "traffic_signals")), N(3, 400, 0), N(4, 0, 400), N(5, 0, -400),
            N(10, -150, 0, ("highway", "crossing"), ("crossing", "marked"), ("crossing_ref", "zebra")),
            N(11, 0, 150, ("highway", "crossing"), ("crossing", "uncontrolled")),
            N(12, 150, 0, ("highway", "crossing"), ("crossing", "traffic_signals"), ("button_operated", "yes")),
        };
        var ways = new[]
        {
            new OsmWay(100, [1, 10, 2, 12, 3], OsmTags.Of(("highway", "primary"), ("name", "Ring"))),
            new OsmWay(101, [4, 11, 2, 5], OsmTags.Of(("highway", "secondary"), ("name", "Gasse"))),
        };
        var sw = plane.ToGeo(new LocalPoint(-350, -350));
        var ne = plane.ToGeo(new LocalPoint(350, 350));
        var area = new BoundingBox(sw.Latitude, sw.Longitude, ne.Latitude, ne.Longitude);
        var network = NetworkCompiler.Compile(new OsmDataSet(nodes, ways, new DateTimeOffset(2026, 11, 14, 10, 0, 0, TimeSpan.Zero)), area);
        return NetworkPackageWriter.ToPackage(network, null, [NetworkImportService.OsmAttribution]);
    }

    [Fact]
    public void Package_has_every_crossing_kind()
    {
        var package = Package();
        var crossings = package.Crossings!;

        Assert.Equal(7, crossings.Count);
        Assert.Equal(["zebra", "uncontrolled", "signal"], crossings.Where(x => !x.Implicit).Select(x => x.Kind));
        Assert.Equal("request", crossings.Single(x => x.OsmId == 12).SignalMode);
        Assert.Equal(4, crossings.Count(x => x.Implicit && x.SignalMode == "parallel"));
        var links = package.Links.Select(l => l.Id).ToHashSet(StringComparer.Ordinal);
        var groups = package.Signals.SelectMany(s => s.Groups).Select(g => g.Id).ToHashSet(StringComparer.Ordinal);
        Assert.All(crossings, x =>
        {
            Assert.All(x.Links, l => Assert.Contains(l.Link, links));
            Assert.True(x.SignalGroup is null || groups.Contains(x.SignalGroup));
            Assert.Equal(2, x.Geometry.Count);
        });
    }

    [Fact]
    public void Package_matches_the_committed_contract_fixture()
    {
        // Regenerate on purpose: TRAFFICSIM_UPDATE_FIXTURES=1 dotnet test
        var json = JsonSerializer.Serialize(Package(), new JsonSerializerOptions(NetworkPackage.JsonOptions) { WriteIndented = true }) + "\n";
        var path = Path.Combine(FixtureDir(), "network-package-crossings-v1.json");
        if (Environment.GetEnvironmentVariable("TRAFFICSIM_UPDATE_FIXTURES") == "1" || !File.Exists(path))
        {
            File.WriteAllText(path, json);
        }

        Assert.Equal(File.ReadAllText(path).ReplaceLineEndings("\n"), json.ReplaceLineEndings("\n"));
    }
}
