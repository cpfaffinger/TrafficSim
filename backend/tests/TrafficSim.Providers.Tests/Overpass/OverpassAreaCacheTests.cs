using System.Net;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Http;
using TrafficSim.Providers.Overpass;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.Overpass;

/// <summary>#138: raw Overpass responses are cached by area and reused for areas inside them.</summary>
public sealed class OverpassAreaCacheTests : IDisposable
{
    private static readonly BoundingBox Wide = new(48.2000, 16.3600, 48.2100, 16.3800);

    private readonly TempDirectory _dir = new();
    private readonly TestTime _time = new(new DateTimeOffset(2026, 11, 15, 12, 0, 0, TimeSpan.Zero));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public void Dispose() => _dir.Dispose();

    private OverpassRoadNetworkSource Create(StubHttpMessageHandler handler, IResponseCache? cache = null) =>
        new(
            ProviderFactory.Client(handler, "https://overpass.test/api/"),
            ProviderFactory.Options(o =>
            {
                o.Overpass.BaseUrl = new Uri("https://overpass.test/api/");
                o.Overpass.Mirrors.Clear();
                o.Overpass.Mirrors.Add(new Uri("https://mirror.test/api/"));
            }),
            [cache ?? new FileResponseCache(_dir.Path, _time)],
            _time);

    [Fact]
    public async Task Areas_inside_a_fetched_area_reuse_its_raw_response_without_a_request()
    {
        var handler = StubHttpMessageHandler.Json(Fixtures.Read("overpass", "roundabout-and-bridge.json"));
        var source = Create(handler);

        var first = await source.FetchAsync(Wide, Ct);
        var inner = new GeoPolygon([new GeoPoint(48.202, 16.362), new GeoPoint(48.202, 16.37), new GeoPoint(48.208, 16.366)]);
        var second = await source.FetchAsync(inner, Ct);
        var third = await source.FetchAsync(new BoundingBox(48.201, 16.361, 48.209, 16.379), Ct);

        Assert.Single(handler.Requests);
        Assert.Equal(first.Ways.Select(w => w.Id), second.Ways.Select(w => w.Id));
        Assert.Equal(first.DataTimestamp, third.DataTimestamp);
    }

    [Fact]
    public async Task Areas_reaching_beyond_every_fetched_area_are_fetched()
    {
        var handler = StubHttpMessageHandler.Json(Fixtures.Read("overpass", "roundabout-and-bridge.json"));
        var source = Create(handler);

        await source.FetchAsync(Wide, Ct);
        await source.FetchAsync(new BoundingBox(48.205, 16.370, 48.215, 16.390), Ct);

        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task A_response_from_a_mirror_serves_later_imports_too()
    {
        var handler = new StubHttpMessageHandler(r => r.RequestUri!.Host == "overpass.test"
            ? new HttpResponseMessage(HttpStatusCode.GatewayTimeout)
            : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Fixtures.Read("overpass", "roundabout-and-bridge.json")) });
        var source = Create(handler);

        await source.FetchAsync(Wide, Ct);
        await source.FetchAsync(Wide, Ct);

        Assert.Equal(["overpass.test", "mirror.test"], handler.Requests.Select(r => r.RequestUri!.Host));
    }

    [Fact]
    public async Task Polygon_imports_fetch_their_bounds_so_the_cached_area_is_a_rectangle()
    {
        var handler = StubHttpMessageHandler.Json(Fixtures.Read("overpass", "roundabout-and-bridge.json"));
        var triangle = new GeoPolygon([new GeoPoint(48.2, 16.36), new GeoPoint(48.2, 16.37), new GeoPoint(48.21, 16.365)]);

        await Create(handler).FetchAsync(triangle, Ct);

        var query = Uri.UnescapeDataString(handler.Requests[0].RequestUri!.Query);
        Assert.DoesNotContain("poly:", query, StringComparison.Ordinal);
        Assert.Contains("(48.2000000,16.3600000,48.2100000,16.3700000)", query, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Expired_areas_and_failed_responses_are_fetched_again()
    {
        var handler = StubHttpMessageHandler.Json(Fixtures.Read("overpass", "roundabout-and-bridge.json"));
        var source = Create(handler);

        await source.FetchAsync(Wide, Ct);
        _time.Advance(TimeSpan.FromDays(8));
        await source.FetchAsync(Wide, Ct);
        Assert.Equal(2, handler.Requests.Count);

        var failing = StubHttpMessageHandler.Json("""{"elements":[],"remark":"runtime error: Query timed out"}""");
        var other = Create(failing, new FileResponseCache(System.IO.Path.Combine(_dir.Path, "other"), _time));
        await Assert.ThrowsAsync<TrafficSim.Application.Providers.ProviderUnavailableException>(() => other.FetchAsync(Wide, Ct));
        await Assert.ThrowsAsync<TrafficSim.Application.Providers.ProviderUnavailableException>(() => other.FetchAsync(Wide, Ct));
        Assert.Equal(4, failing.Requests.Count); // primary and mirror, twice: nothing cached
    }
}
