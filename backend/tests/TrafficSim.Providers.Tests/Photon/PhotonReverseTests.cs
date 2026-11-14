using TrafficSim.Application.Geocoding;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Photon;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.Photon;

public class PhotonReverseTests
{
    [Fact]
    public async Task Reverse_returns_first_feature()
    {
        var handler = StubHttpMessageHandler.Json(Fixtures.Read("photon", "search-wien-karlsplatz.json"));
        var provider = new PhotonGeocodingProvider(ProviderFactory.Client(handler, "https://photon.test/"), ProviderFactory.Options());

        var result = await provider.ReverseAsync(new ReverseGeocodeQuery(new GeoPoint(48.2004, 16.3699), "de"), TestContext.Current.CancellationToken);

        Assert.Equal("Karlsplatz, 1040 Wien, Österreich", result!.Label);
        Assert.Equal("https://photon.test/reverse?lat=48.200400&lon=16.369900&limit=1&lang=de", handler.Requests[0].RequestUri!.AbsoluteUri);
    }

    [Fact]
    public async Task Reverse_without_features_is_null()
    {
        var provider = new PhotonGeocodingProvider(
            ProviderFactory.Client(StubHttpMessageHandler.Json("""{"features":[]}"""), "https://photon.test/"), ProviderFactory.Options());

        Assert.Null(await provider.ReverseAsync(new ReverseGeocodeQuery(new GeoPoint(0, 0)), TestContext.Current.CancellationToken));
    }
}
