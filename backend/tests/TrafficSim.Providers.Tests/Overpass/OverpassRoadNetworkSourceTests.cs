using System.Net;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Overpass;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.Overpass;

public class OverpassRoadNetworkSourceTests
{
    private static readonly BoundingBox Area = new(48.2000, 16.3600, 48.2050, 16.3700);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static OverpassRoadNetworkSource Create(StubHttpMessageHandler handler) =>
        new(ProviderFactory.Client(handler, "https://overpass.test/api/"), ProviderFactory.Options(o =>
        {
            o.Overpass.BaseUrl = new Uri("https://overpass.test/api/");
            o.Overpass.Mirrors.Clear();
            o.Overpass.Mirrors.Add(new Uri("https://mirror.test/api/"));
        }));

    [Fact]
    public async Task Maps_fixture_to_canonical_data_set()
    {
        var handler = StubHttpMessageHandler.Json(Fixtures.Read("overpass", "roundabout-and-bridge.json"));

        var data = await Create(handler).FetchAsync(Area, Ct);

        Assert.Equal(new DateTimeOffset(2026, 11, 14, 10, 0, 0, TimeSpan.Zero), data.DataTimestamp);
        Assert.Equal(3, data.Ways.Count);
        var bridge = Assert.Single(data.Ways, w => w.Tags.TryGetValue("bridge", out var b) && b == "yes");
        Assert.Equal("1", bridge.Tags["layer"]);
        Assert.Equal("traffic_signals", data.Nodes[103].Tags["highway"]);
        Assert.Empty(data.Nodes[101].Tags);
        Assert.StartsWith("https://overpass.test/api/interpreter?data=", handler.Requests[0].RequestUri!.AbsoluteUri, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Falls_back_to_mirror_on_failure()
    {
        var handler = new StubHttpMessageHandler(r => r.RequestUri!.Host == "overpass.test"
            ? new HttpResponseMessage(HttpStatusCode.GatewayTimeout)
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("""{"elements":[]}""") });

        var data = await Create(handler).FetchAsync(Area, Ct);

        Assert.Empty(data.Ways);
        Assert.Equal(["overpass.test", "mirror.test"], handler.Requests.Select(r => r.RequestUri!.Host));
    }

    [Fact]
    public async Task Runtime_error_remark_is_a_failure()
    {
        var handler = StubHttpMessageHandler.Json("""{"elements":[],"remark":"runtime error: Query timed out"}""");

        var ex = await Assert.ThrowsAsync<ProviderUnavailableException>(() => Create(handler).FetchAsync(Area, Ct));

        Assert.Contains("runtime error", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Missing_elements_is_a_failure() =>
        await Assert.ThrowsAsync<ProviderUnavailableException>(() => Create(StubHttpMessageHandler.Json("{}")).FetchAsync(Area, Ct));

    [Fact]
    public void Query_selects_drivable_ways_in_bbox_with_nodes()
    {
        var query = OverpassQuery.Build(Area, 90);

        Assert.StartsWith("[out:json][timeout:90];", query, StringComparison.Ordinal);
        Assert.Contains("(48.2000000,16.3600000,48.2050000,16.3700000)", query, StringComparison.Ordinal);
        Assert.Contains("motorway_link", query, StringComparison.Ordinal);
        Assert.Contains("[\"service\"!~", query, StringComparison.Ordinal);
        Assert.EndsWith("(._;>;);out body qt;", query, StringComparison.Ordinal);
    }

    [Fact]
    public void Exposes_registry_properties()
    {
        var source = Create(StubHttpMessageHandler.Json("{}"));

        Assert.Equal("overpass", source.Name);
        Assert.Equal(10, source.Priority);
        Assert.Equal(50, source.MaxAreaSquareKilometers);
        Assert.Contains("OpenStreetMap", source.Attribution, StringComparison.Ordinal);
    }
}
