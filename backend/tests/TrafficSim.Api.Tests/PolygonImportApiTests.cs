using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using TrafficSim.Api.Endpoints;

namespace TrafficSim.Api.Tests;

public class PolygonImportApiTests : IClassFixture<TrafficSimApiFactory>
{
    private readonly TrafficSimApiFactory _factory;

    public PolygonImportApiTests(TrafficSimApiFactory factory) => _factory = factory;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Polygon_import_is_stored_and_carried_in_the_package()
    {
        using var client = _factory.CreateClient();
        double[][] ring = [[16.70, 48.20], [16.715, 48.20], [16.715, 48.205], [16.7075, 48.205], [16.7075, 48.21], [16.70, 48.21]];

        var response = await client.PostAsJsonAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new ImportRequest(null, ring), Ct);
        var job = (await response.Content.ReadFromJsonAsync<ImportJobDto>(Ct))!;
        for (var i = 0; i < 100 && job.Status != "completed"; i++)
        {
            await Task.Delay(50, Ct);
            job = (await client.GetFromJsonAsync<ImportJobDto>(new Uri($"/api/v1/networks/import/{job.JobId}", UriKind.Relative), Ct))!;
        }

        Assert.Equal("completed", job.Status);
        Assert.Equal(6, job.Polygon!.Length);
        Assert.Equal([16.70, 48.20, 16.715, 48.21], job.Bbox);
        var info = await client.GetFromJsonAsync<NetworkBaselineDto>(new Uri($"/api/v1/networks/{job.BaselineId}", UriKind.Relative), Ct);
        Assert.Equal(6, info!.Polygon!.Length);
        using var package = JsonDocument.Parse(await client.GetStringAsync(new Uri($"/api/v1/networks/{job.BaselineId}/package", UriKind.Relative), Ct));
        Assert.Equal(6, package.RootElement.GetProperty("area").GetArrayLength());

        // The same polygon is reused; the bbox of it is a different import.
        var again = await client.PostAsJsonAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new ImportRequest(null, ring), Ct);
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
    }

    [Theory]
    [InlineData("""{"polygon":[[16.7,48.2],[16.71,48.2]]}""")]
    [InlineData("""{"polygon":[[16.7,48.2,1],[16.71,48.2],[16.71,48.21]]}""")]
    [InlineData("""{}""")]
    public async Task Invalid_polygons_are_rejected(string body)
    {
        using var client = _factory.CreateClient();

        var response = await client.PostAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new StringContent(body, System.Text.Encoding.UTF8, "application/json"), Ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
