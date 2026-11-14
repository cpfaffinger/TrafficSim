using System.Net;
using System.Net.Http.Json;
using TrafficSim.Api.Endpoints;
using TrafficSim.Application.Providers;

namespace TrafficSim.Api.Tests;

public class ProviderApiTests : IClassFixture<TrafficSimApiFactory>
{
    private readonly TrafficSimApiFactory _factory;

    public ProviderApiTests(TrafficSimApiFactory factory)
    {
        _factory = factory;
        _factory.Geocoder.Failure = null;
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Providers_endpoint_lists_registry_with_capabilities()
    {
        using var client = _factory.CreateClient();

        var providers = await client.GetFromJsonAsync<List<ProviderDto>>(new Uri("/api/v1/providers", UriKind.Relative), Ct);

        Assert.NotNull(providers);
        var overpass = Assert.Single(providers, p => p.Name == "overpass");
        Assert.Equal(["roadNetwork"], overpass.Capabilities);
        Assert.True(overpass.Enabled);
        var google = Assert.Single(providers, p => p.Name == "google");
        Assert.False(google.Enabled);
        Assert.True(google.Commercial);
        Assert.Contains(providers, p => p.Capabilities.Contains("basemap"));
    }

    [Fact]
    public async Task Meta_lists_attributions_of_enabled_providers_only()
    {
        using var client = _factory.CreateClient();

        var meta = await client.GetFromJsonAsync<MetaResponse>(new Uri("/api/v1/meta", UriKind.Relative), Ct);

        Assert.NotNull(meta);
        Assert.Contains(meta.Attributions, a => a.Contains("Photon", StringComparison.Ordinal));
        Assert.DoesNotContain(meta.Attributions, a => a.Contains("Google", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Reverse_geocode_returns_nearest_feature()
    {
        using var client = _factory.CreateClient();

        var body = await client.GetFromJsonAsync<ReverseGeocodeResponseDto>(
            new Uri("/api/v1/geocode/reverse?lat=48.2&lon=16.37&lang=DE", UriKind.Relative), Ct);

        Assert.NotNull(body?.Result);
        Assert.Equal("Ring, Wien", body.Result.Label);
        Assert.Equal("fake", body.Provider);
        Assert.Equal("de", _factory.Geocoder.LastReverseQuery!.Language);
    }

    [Fact]
    public async Task Reverse_geocode_without_match_returns_null_result()
    {
        using var client = _factory.CreateClient();

        var body = await client.GetFromJsonAsync<ReverseGeocodeResponseDto>(
            new Uri("/api/v1/geocode/reverse?lat=85&lon=0", UriKind.Relative), Ct);

        Assert.NotNull(body);
        Assert.Null(body.Result);
    }

    [Theory]
    [InlineData("/api/v1/geocode/reverse")]
    [InlineData("/api/v1/geocode/reverse?lat=1")]
    [InlineData("/api/v1/geocode/reverse?lat=91&lon=0")]
    public async Task Reverse_geocode_rejects_invalid_coordinates(string url)
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(new Uri(url, UriKind.Relative), Ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Reverse_geocode_returns_503_when_all_providers_fail()
    {
        _factory.Geocoder.Failure = new ProviderUnavailableException("fake", "down");
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(new Uri("/api/v1/geocode/reverse?lat=1&lon=2", UriKind.Relative), Ct);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }
}
