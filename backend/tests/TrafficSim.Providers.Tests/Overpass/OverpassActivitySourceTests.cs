using System.Net;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Overpass;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.Overpass;

public class OverpassActivitySourceTests
{
    private static readonly GeoPolygon Area = GeoPolygon.FromBoundingBox(new BoundingBox(48.2000, 16.3600, 48.2050, 16.3700));

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static OverpassActivitySource Create(StubHttpMessageHandler handler) =>
        new(ProviderFactory.Client(handler, "https://overpass.test/api/"), ProviderFactory.Options(o =>
        {
            o.Overpass.BaseUrl = new Uri("https://overpass.test/api/");
            o.Overpass.Mirrors.Clear();
            o.Overpass.Mirrors.Add(new Uri("https://mirror-a.test/api/"));
            o.Overpass.Mirrors.Add(new Uri("https://mirror-b.test/api/"));
        }));

    [Fact]
    public async Task Falls_back_through_the_mirrors()
    {
        var handler = new StubHttpMessageHandler(r => r.RequestUri!.Host switch
        {
            "overpass.test" => new HttpResponseMessage(HttpStatusCode.TooManyRequests),
            "mirror-a.test" => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"elements":[],"remark":"runtime error: Query timed out"}"""),
            },
            _ => new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("""{"elements":[{"type":"node","id":1,"lat":48.201,"lon":16.361,"tags":{"shop":"bakery"}}]}"""),
            },
        });

        var pois = await Create(handler).FetchAsync(Area, Ct);

        Assert.Equal("bakery", Assert.Single(pois).Tags["shop"]);
        Assert.Equal(["overpass.test", "mirror-a.test", "mirror-b.test"], handler.Requests.Select(r => r.RequestUri!.Host).Distinct());
    }
}
