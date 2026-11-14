using System.Net;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Nominatim;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.Nominatim;

public class NominatimProviderTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static NominatimProvider Create(StubHttpMessageHandler handler) =>
        new(ProviderFactory.Client(handler, "https://nominatim.test/"), ProviderFactory.Options());

    [Fact]
    public async Task Reverse_maps_place_from_fixture()
    {
        var handler = StubHttpMessageHandler.Json(Fixtures.Read("nominatim", "reverse-wien-oper.json"));

        var result = await Create(handler).ReverseAsync(new ReverseGeocodeQuery(new GeoPoint(48.2028, 16.3689), "de"), Ct);

        Assert.NotNull(result);
        Assert.Equal("Opernring, Innere Stadt, Wien, 1010, Österreich", result.Label);
        Assert.Equal("highway:primary", result.Category);
        Assert.Equal("way/4583442", result.OsmReference);
        Assert.Equal(48.2021, result.Extent!.South);
        Assert.Equal(16.3712, result.Extent.East);
        Assert.Equal(
            "https://nominatim.test/reverse?format=jsonv2&lat=48.202800&lon=16.368900&zoom=18&accept-language=de",
            handler.Requests[0].RequestUri!.AbsoluteUri);
    }

    [Fact]
    public async Task Reverse_error_body_means_nothing_found()
    {
        var result = await Create(StubHttpMessageHandler.Json("""{"error":"Unable to geocode"}"""))
            .ReverseAsync(new ReverseGeocodeQuery(new GeoPoint(0, 0)), Ct);

        Assert.Null(result);
    }

    [Fact]
    public async Task Search_maps_list_and_skips_invalid_entries()
    {
        var handler = StubHttpMessageHandler.Json("""
            [{"lat":"48.2","lon":"16.37","display_name":"A","osm_type":"node","osm_id":1,"boundingbox":["x","1","2","3"]},
             {"lat":"bad","lon":"16"},
             {"lat":"95","lon":"16"}]
            """);

        var results = await Create(handler).SearchAsync(new GeocodeQuery("Oper", 3, "de"), Ct);

        var only = Assert.Single(results);
        Assert.Equal("A", only.Label);
        Assert.Equal("unknown", only.Category);
        Assert.Equal("node/1", only.OsmReference);
        Assert.Null(only.Extent);
        Assert.Equal("https://nominatim.test/search?format=jsonv2&q=Oper&limit=3&accept-language=de", handler.Requests[0].RequestUri!.AbsoluteUri);
    }

    [Fact]
    public async Task Http_errors_become_provider_unavailable()
    {
        var ex = await Assert.ThrowsAsync<ProviderUnavailableException>(
            () => Create(StubHttpMessageHandler.Json("{}", HttpStatusCode.TooManyRequests)).ReverseAsync(new ReverseGeocodeQuery(new GeoPoint(0, 0)), Ct));

        Assert.Equal("nominatim", ex.ProviderName);
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("""["1","2","3"]""", null)]
    [InlineData("""["2","1","3","4"]""", null)]
    [InlineData("""["1","2","3","4"]""", "1,3,2,4")]
    public void Extent_requires_four_ordered_values(string? json, string? expected)
    {
        var box = json is null ? null : System.Text.Json.JsonSerializer.Deserialize<List<string>>(json);

        var extent = NominatimMapper.MapExtent(box);

        Assert.Equal(expected, extent is null ? null : FormattableString.Invariant($"{extent.South},{extent.West},{extent.North},{extent.East}"));
    }
}
