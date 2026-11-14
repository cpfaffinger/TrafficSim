using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Google;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.Google;

public class GoogleGeocodingProviderTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static GoogleGeocodingProvider Create(StubHttpMessageHandler handler) =>
        new(ProviderFactory.Client(handler, "https://maps.test/"), ProviderFactory.Options(o => o.Google.ApiKey = "k&y"));

    [Fact]
    public async Task Maps_results_from_fixture_and_sends_key()
    {
        var handler = StubHttpMessageHandler.Json(Fixtures.Read("google", "geocode-stephansplatz.json"));
        var provider = Create(handler);

        var results = await provider.SearchAsync(new GeocodeQuery("Stephansplatz", 5, "de", new GeoPoint(48.2, 16.37)), Ct);

        var r = Assert.Single(results);
        Assert.Equal("Stephansplatz, 1010 Wien, Österreich", r.Label);
        Assert.Equal("google:route", r.Category);
        Assert.Equal(48.2084, r.Extent!.North);
        Assert.Null(r.OsmReference);
        var uri = handler.Requests[0].RequestUri!.AbsoluteUri;
        Assert.Contains("address=Stephansplatz", uri, StringComparison.Ordinal);
        Assert.Contains("&language=de", uri, StringComparison.Ordinal);
        Assert.Contains("&bounds=48.000000,16.170000%7C48.400000,16.570000", uri, StringComparison.Ordinal);
        Assert.EndsWith("&key=k%26y", uri, StringComparison.Ordinal);
        Assert.Equal("Powered by Google", provider.Attribution);
        Assert.Equal("google", provider.Name);
        Assert.Equal(90, provider.Priority);
    }

    [Fact]
    public void Zero_results_is_empty() => Assert.Empty(GoogleGeocodingProvider.Map(new GoogleGeocodeResponse("ZERO_RESULTS", null, null), 5));

    [Theory]
    [InlineData("REQUEST_DENIED")]
    [InlineData("OVER_QUERY_LIMIT")]
    [InlineData(null)]
    public void Error_status_is_provider_unavailable(string? status) =>
        Assert.Throws<ProviderUnavailableException>(() => GoogleGeocodingProvider.Map(new GoogleGeocodeResponse(status, null, "x"), 5));

    [Fact]
    public void Invalid_locations_are_skipped_and_limit_applies()
    {
        var ok = new GoogleResult("A", new GoogleGeometry(new GoogleLatLng(1, 2), null), null);
        var bad = new GoogleResult("B", new GoogleGeometry(new GoogleLatLng(100, 2), null), ["route"]);

        var results = GoogleGeocodingProvider.Map(new GoogleGeocodeResponse("OK", [bad, ok, ok], null), 1);

        Assert.Equal("google:unknown", Assert.Single(results).Category);
    }

    [Fact]
    public void Usable_only_with_key_and_enabled()
    {
        Assert.False(GoogleGeocodingProvider.IsUsable(new GoogleOptions { ApiKey = "k" }));
        Assert.False(GoogleGeocodingProvider.IsUsable(new GoogleOptions { Enabled = true }));
        Assert.True(GoogleGeocodingProvider.IsUsable(new GoogleOptions { Enabled = true, ApiKey = "k" }));
    }
}
