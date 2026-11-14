using System.Text.Json;
using TrafficSim.Application.Networks;
using TrafficSim.Application.Scenarios;
using TrafficSim.Domain.Activity;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Tests.Scenarios;

public class ScenarioGeneratorTests
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

    private static NetworkPackage Golden() =>
        JsonSerializer.Deserialize<NetworkPackage>(File.ReadAllText(Path.Combine(FixtureDir(), "network-package-v1.json")), NetworkPackage.JsonOptions)!;

    /// <summary>Apartments west of the junction, offices east, a school and a stadium north (fixture origin 48.2082, 16.3738).</summary>
    private static List<OsmPoi> Pois()
    {
        var plane = new LocalTangentPlane(new GeoPoint(48.2082, 16.3738));
        OsmPoi At(double x, double y, params (string, string)[] tags) => new(plane.ToGeo(new LocalPoint(x, y)), OsmTags.Of(tags));
        return
        [
            At(-120, -12, ("building", "apartments"), ("building:levels", "6")),
            At(-80, 12, ("building", "apartments")),
            At(-100, 20, ("building", "house")),
            At(120, -12, ("building", "office"), ("building:levels", "5")),
            At(90, 10, ("shop", "supermarket")),
            At(-12, 120, ("amenity", "school")),
            At(12, 130, ("leisure", "stadium")),
            At(100, -14, ("building", "warehouse")),
            At(130, 14, ("landuse", "industrial")),
            At(140, -16, ("landuse", "industrial")),
            At(5000, 5000, ("building", "apartments")), // far away: not attachable
            At(0, 40, ("amenity", "parking"), ("capacity", "120")),
        ];
    }

    [Fact]
    public void Classifier_maps_buildings_land_use_and_pois()
    {
        var p = new GeoPoint(0, 0);
        IEnumerable<ActivityFeature> C(params (string, string)[] tags) => ActivityClassifier.Classify(new OsmPoi(p, OsmTags.Of(tags)));

        Assert.Equal(24, Assert.Single(C(("building", "apartments"), ("building:levels", "6"))).Weight);
        Assert.Equal(16, Assert.Single(C(("building", "apartments"))).Weight);
        Assert.Equal(ActivityKind.Housing, Assert.Single(C(("building", "detached"))).Kind);
        Assert.Equal(125, Assert.Single(C(("building", "office"), ("building:levels", "5"))).Weight);
        Assert.Equal([ActivityKind.Retail, ActivityKind.Work], C(("shop", "supermarket")).Select(f => f.Kind));
        Assert.Equal([ActivityKind.Work, ActivityKind.Freight], C(("landuse", "industrial")).Select(f => f.Kind));
        Assert.Empty(C(("landuse", "industrial"), ("building", "yes")));
        Assert.Equal(120, Assert.Single(C(("amenity", "parking"), ("capacity", "120"))).Weight);
        Assert.Equal(50, Assert.Single(C(("amenity", "parking"))).Weight);
        Assert.Equal(5000, Assert.Single(C(("leisure", "stadium"))).Weight);
        Assert.Equal(2, C(("amenity", "university")).Count());
        Assert.Empty(C(("highway", "bus_stop")));
        Assert.Single(C(("office", "company")));
        Assert.Single(C(("building", "office"), ("office", "company")));
    }

    [Fact]
    public void Generates_scenarios_with_zones_od_and_a_data_summary()
    {
        var (scenarios, summary) = ScenarioGenerator.Generate(Golden(), Pois(), 0.07);

        Assert.True(summary.HasActivityData);
        Assert.Equal(1, summary.UnattachedFeatures);
        Assert.Equal(1, summary.Features["parking"]);
        Assert.True(summary.Totals["housing"] > 0);
        Assert.InRange(summary.CarShare, 0.2, 0.7);
        Assert.Equal(
            ["morning", "midday", "evening", "saturday", "night", "stress", "event", "freight"],
            scenarios.Select(s => s.Key));

        using var morning = JsonDocument.Parse(scenarios[0].DemandJson);
        var root = morning.RootElement;
        Assert.Equal(23400, root.GetProperty("startTimeOfDay").GetDouble());
        Assert.False(root.GetProperty("autoZones").GetBoolean());
        var zones = root.GetProperty("zones").EnumerateArray().ToList();
        Assert.Contains(zones, z => z.GetProperty("id").GetString() == "ext" && z.GetProperty("nodes").GetArrayLength() == 8);
        var od = root.GetProperty("od").EnumerateArray().ToList();
        Assert.NotEmpty(od);
        Assert.All(od, o => Assert.True(o.GetProperty("vph").GetDouble() >= 0.2));
        // morning: residential zones produce, inbound commuters arrive from outside
        Assert.Contains(od, o => o.GetProperty("from").GetString() == "ext");
        Assert.Contains(od, o => o.GetProperty("to").GetString() == "ext");
        Assert.Contains(od, o => o.TryGetProperty("driverMix", out _));

        using var stress = JsonDocument.Parse(scenarios.Single(s => s.Key == "stress").DemandJson);
        Assert.Equal(1820, stress.RootElement.GetProperty("profiles").GetProperty("motorway").GetProperty("volumePerLane").GetDouble());
        using var freight = JsonDocument.Parse(scenarios.Single(s => s.Key == "freight").DemandJson);
        Assert.Contains(freight.RootElement.GetProperty("od").EnumerateArray(), o => o.TryGetProperty("vehicleMix", out _));
    }

    [Fact]
    public void Without_activity_data_falls_back_to_residential_generation()
    {
        var (scenarios, summary) = ScenarioGenerator.Generate(Golden(), [], 0.07);

        Assert.False(summary.HasActivityData);
        Assert.Equal(6, scenarios.Count);
        using var doc = JsonDocument.Parse(scenarios.Single(s => s.Key == "saturday").DemandJson);
        Assert.True(doc.RootElement.GetProperty("autoZones").GetBoolean());
        Assert.Equal("flat", doc.RootElement.GetProperty("demandCurve").GetString());
        Assert.Equal(840, doc.RootElement.GetProperty("profiles").GetProperty("motorway").GetProperty("volumePerLane").GetDouble());
    }

    [Fact]
    public void Generated_demand_matches_the_committed_contract_fixture()
    {
        // The sim core runs this file in its contract test (sim-core/tests); regenerate on purpose:
        // TRAFFICSIM_UPDATE_FIXTURES=1 dotnet test
        var (scenarios, _) = ScenarioGenerator.Generate(Golden(), Pois(), 0.07);
        var json = JsonSerializer.Serialize(
            scenarios.ToDictionary(s => s.Key, s => JsonDocument.Parse(s.DemandJson).RootElement),
            new JsonSerializerOptions { WriteIndented = true }) + "\n";
        var path = Path.Combine(FixtureDir(), "generated-demand-v1.json");
        if (Environment.GetEnvironmentVariable("TRAFFICSIM_UPDATE_FIXTURES") == "1" || !File.Exists(path))
        {
            File.WriteAllText(path, json);
        }

        Assert.Equal(File.ReadAllText(path).ReplaceLineEndings("\n"), json.ReplaceLineEndings("\n"));
    }
}
