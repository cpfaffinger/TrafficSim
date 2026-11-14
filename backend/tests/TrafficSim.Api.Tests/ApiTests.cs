using System.Net;
using System.Net.Http.Json;
using TrafficSim.Api.Endpoints;
using TrafficSim.Application.Providers;

namespace TrafficSim.Api.Tests;

public class ApiTests : IClassFixture<TrafficSimApiFactory>
{
    private readonly TrafficSimApiFactory _factory;

    public ApiTests(TrafficSimApiFactory factory)
    {
        _factory = factory;
        _factory.Geocoder.Failure = null;
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Liveness_endpoint_is_healthy_without_database()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(new Uri("/healthz", UriKind.Relative), Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Readiness_endpoint_returns_json_report()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(new Uri("/readyz", UriKind.Relative), Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("\"status\"", await response.Content.ReadAsStringAsync(Ct), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Responses_carry_cross_origin_isolation_headers()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(new Uri("/healthz", UriKind.Relative), Ct);

        Assert.Equal("same-origin", response.Headers.GetValues("Cross-Origin-Opener-Policy").Single());
        Assert.Equal("require-corp", response.Headers.GetValues("Cross-Origin-Embedder-Policy").Single());
        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
    }

    [Fact]
    public async Task Meta_lists_osm_and_provider_attributions()
    {
        using var client = _factory.CreateClient();

        var meta = await client.GetFromJsonAsync<MetaResponse>(new Uri("/api/v1/meta", UriKind.Relative), Ct);

        Assert.NotNull(meta);
        Assert.Equal("TrafficSim", meta.Name);
        Assert.Contains(MetaEndpoints.OsmAttribution, meta.Attributions);
        Assert.Contains("Fake attribution", meta.Attributions);
    }

    [Fact]
    public async Task Geocode_returns_mapped_results_with_attribution()
    {
        using var client = _factory.CreateClient();

        var body = await client.GetFromJsonAsync<GeocodeResponseDto>(
            new Uri("/api/v1/geocode?q=Karlsplatz&limit=2&lang=de&lat=48.2&lon=16.37", UriKind.Relative), Ct);

        Assert.NotNull(body);
        Assert.Equal("fake", body.Provider);
        Assert.Equal("Fake attribution", body.Attribution);
        Assert.Equal(2, body.Results.Count);
        Assert.Equal([16.3672, 48.1989, 16.3726, 48.2017], body.Results[0].Bbox!);
        Assert.Null(body.Results[1].Bbox);
        Assert.Equal(2, _factory.Geocoder.LastQuery!.Limit);
        Assert.Equal("de", _factory.Geocoder.LastQuery.Language);
        Assert.Equal(48.2, _factory.Geocoder.LastQuery.Bias!.Value.Latitude);
    }

    [Theory]
    [InlineData("/api/v1/geocode")]
    [InlineData("/api/v1/geocode?q=%20")]
    [InlineData("/api/v1/geocode?q=x&limit=0")]
    [InlineData("/api/v1/geocode?q=x&lat=95&lon=0")]
    public async Task Geocode_rejects_invalid_queries_with_problem_details(string url)
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(new Uri(url, UriKind.Relative), Ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Geocode_returns_503_when_all_providers_fail()
    {
        _factory.Geocoder.Failure = new ProviderUnavailableException("fake", "down");
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(new Uri("/api/v1/geocode?q=x", UriKind.Relative), Ct);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    [Fact]
    public async Task Unknown_api_route_returns_404_problem()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(new Uri("/api/v1/does-not-exist", UriKind.Relative), Ct);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task OpenApi_document_is_served()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync(new Uri("/api/openapi/v1.json", UriKind.Relative), Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("/api/v1/geocode", await response.Content.ReadAsStringAsync(Ct), StringComparison.Ordinal);
    }
}
