using System.Net;
using System.Net.Http.Json;
using TrafficSim.Api.Endpoints;

namespace TrafficSim.Api.Tests;

public class NetworkApiTests : IClassFixture<TrafficSimApiFactory>
{
    private readonly TrafficSimApiFactory _factory;

    public NetworkApiTests(TrafficSimApiFactory factory) => _factory = factory;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Import_runs_in_background_and_serves_the_package()
    {
        using var client = _factory.CreateClient();
        double[] bbox = [16.3600, 48.2000, 16.3750, 48.2100];

        var response = await client.PostAsJsonAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new ImportRequest(bbox), Ct);
        Assert.True(response.StatusCode is HttpStatusCode.Accepted or HttpStatusCode.OK);
        var job = await response.Content.ReadFromJsonAsync<ImportJobDto>(Ct);
        Assert.NotNull(job);

        ImportJobDto? status = job;
        for (var i = 0; i < 100 && status!.Status != "completed"; i++)
        {
            await Task.Delay(50, Ct);
            status = await client.GetFromJsonAsync<ImportJobDto>(new Uri($"/api/v1/networks/import/{job.JobId}", UriKind.Relative), Ct);
        }

        Assert.Equal("completed", status!.Status);
        var baselineId = status.BaselineId!.Value;

        var info = await client.GetFromJsonAsync<NetworkBaselineDto>(new Uri($"/api/v1/networks/{baselineId}", UriKind.Relative), Ct);
        Assert.Equal("fake-roads", info!.Source);
        var list = await client.GetFromJsonAsync<List<NetworkBaselineDto>>(new Uri("/api/v1/networks?limit=5", UriKind.Relative), Ct);
        Assert.Contains(list!, b => b.Id == baselineId);

        using var packageResponse = await client.GetAsync(new Uri($"/api/v1/networks/{baselineId}/package", UriKind.Relative), Ct);
        Assert.Equal(HttpStatusCode.OK, packageResponse.StatusCode);
        Assert.Contains("immutable", packageResponse.Headers.CacheControl!.ToString(), StringComparison.Ordinal);
        var json = await packageResponse.Content.ReadAsStringAsync(Ct);
        Assert.Contains("\"formatVersion\":1", json, StringComparison.Ordinal);

        using var gzipRequest = new HttpRequestMessage(HttpMethod.Get, new Uri($"/api/v1/networks/{baselineId}/package", UriKind.Relative));
        gzipRequest.Headers.AcceptEncoding.ParseAdd("gzip");
        using var gzipResponse = await client.SendAsync(gzipRequest, Ct);
        Assert.Contains("gzip", gzipResponse.Content.Headers.ContentEncoding);

        // identical area is reused
        var again = await client.PostAsJsonAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new ImportRequest(bbox), Ct);
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
    }

    [Theory]
    [InlineData(null, HttpStatusCode.BadRequest)]
    [InlineData(new[] { 16.37, 48.21, 16.36, 48.2 }, HttpStatusCode.BadRequest)]
    [InlineData(new[] { 16.0, 48.0, 17.0, 49.0 }, HttpStatusCode.UnprocessableEntity)]
    [InlineData(new[] { 16.36, 48.2, 16.36001, 48.20001 }, HttpStatusCode.UnprocessableEntity)]
    public async Task Invalid_areas_are_rejected(double[]? bbox, HttpStatusCode expected)
    {
        using var client = _factory.CreateClient();

        var response = await client.PostAsJsonAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new ImportRequest(bbox), Ct);

        Assert.Equal(expected, response.StatusCode);
    }

    [Fact]
    public async Task Unknown_ids_return_404()
    {
        using var client = _factory.CreateClient();
        var id = Guid.NewGuid();

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/networks/import/{id}", UriKind.Relative), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/networks/{id}", UriKind.Relative), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/networks/{id}/package", UriKind.Relative), Ct)).StatusCode);
    }
}
