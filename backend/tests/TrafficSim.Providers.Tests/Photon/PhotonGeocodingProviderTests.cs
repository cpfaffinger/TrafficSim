using System.Net;
using Microsoft.Extensions.Options;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Photon;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.Photon;

public class PhotonGeocodingProviderTests
{
    private static readonly string Fixture =
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "photon", "search-wien-karlsplatz.json"));

    [Fact]
    public async Task Maps_features_to_canonical_results_and_skips_invalid_ones()
    {
        var provider = CreateProvider(StubHttpMessageHandler.Json(Fixture));

        var results = await provider.SearchAsync(new GeocodeQuery("Karlsplatz"), TestContext.Current.CancellationToken);

        Assert.Equal(2, results.Count);
        var square = results[0];
        Assert.Equal("Karlsplatz, 1040 Wien, Österreich", square.Label);
        Assert.Equal(48.2004, square.Location.Latitude);
        Assert.Equal(16.3699, square.Location.Longitude);
        Assert.Equal("highway:pedestrian", square.Category);
        Assert.Equal("way/25398743", square.OsmReference);
        Assert.NotNull(square.Extent);
        Assert.Equal(48.1989, square.Extent!.South);
        Assert.Equal(16.3672, square.Extent.West);
        Assert.Equal(48.2017, square.Extent.North);
        Assert.Equal(16.3726, square.Extent.East);

        var station = results[1];
        Assert.Equal("Karlsplatz, Karlsplatz 1, Wien, Österreich", station.Label);
        Assert.Equal("node/1234567", station.OsmReference);
        Assert.Null(station.Extent);
    }

    [Fact]
    public async Task Builds_request_with_limit_language_and_location_bias()
    {
        var handler = StubHttpMessageHandler.Json("""{"features":[]}""");
        var provider = CreateProvider(handler);

        await provider.SearchAsync(new GeocodeQuery("Ring Straße", 7, "de", new GeoPoint(48.2, 16.37)), TestContext.Current.CancellationToken);

        var uri = Assert.Single(handler.Requests).RequestUri!.AbsoluteUri;
        Assert.Equal("https://photon.test/api/?q=Ring%20Stra%C3%9Fe&limit=7&lang=de&lat=48.200000&lon=16.370000", uri);
    }

    [Fact]
    public void Unsupported_language_is_omitted() =>
        Assert.DoesNotContain("lang=", PhotonGeocodingProvider.BuildSearchPath(new GeocodeQuery("x", language: "es")), StringComparison.Ordinal);

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.BadGateway)]
    public async Task Non_success_status_becomes_provider_unavailable(HttpStatusCode status)
    {
        var provider = CreateProvider(StubHttpMessageHandler.Json("{}", status));

        var ex = await Assert.ThrowsAsync<ProviderUnavailableException>(
            () => provider.SearchAsync(new GeocodeQuery("x"), TestContext.Current.CancellationToken));

        Assert.Equal("photon", ex.ProviderName);
        Assert.Contains(((int)status).ToString(System.Globalization.CultureInfo.InvariantCulture), ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Invalid_json_becomes_provider_unavailable()
    {
        var provider = CreateProvider(StubHttpMessageHandler.Json("<html>maintenance</html>"));

        await Assert.ThrowsAsync<ProviderUnavailableException>(
            () => provider.SearchAsync(new GeocodeQuery("x"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Network_errors_become_provider_unavailable()
    {
        var provider = CreateProvider(StubHttpMessageHandler.Throws(new HttpRequestException("connection refused")));

        await Assert.ThrowsAsync<ProviderUnavailableException>(
            () => provider.SearchAsync(new GeocodeQuery("x"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Timeouts_become_provider_unavailable()
    {
        var provider = CreateProvider(StubHttpMessageHandler.Throws(new TaskCanceledException("timeout")));

        await Assert.ThrowsAsync<ProviderUnavailableException>(
            () => provider.SearchAsync(new GeocodeQuery("x"), TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Empty_body_yields_empty_results()
    {
        var provider = CreateProvider(StubHttpMessageHandler.Json("{}"));

        var results = await provider.SearchAsync(new GeocodeQuery("x"), TestContext.Current.CancellationToken);

        Assert.Empty(results);
    }

    [Fact]
    public void Exposes_name_priority_and_attribution()
    {
        var provider = CreateProvider(StubHttpMessageHandler.Json("{}"));

        Assert.Equal("photon", provider.Name);
        Assert.Equal(10, provider.Priority);
        Assert.Contains("OpenStreetMap", provider.Attribution, StringComparison.Ordinal);
    }

    private static PhotonGeocodingProvider CreateProvider(HttpMessageHandler handler)
    {
        var client = new HttpClient(handler) { BaseAddress = new Uri("https://photon.test/") };
        return new PhotonGeocodingProvider(client, Options.Create(new ProvidersOptions()));
    }
}
