using System.Net;
using System.Net.Http.Json;
using TrafficSim.Api.Endpoints;

namespace TrafficSim.Api.Tests;

public class NetworkManagementApiTests : IClassFixture<TrafficSimApiFactory>
{
    private readonly TrafficSimApiFactory _factory;

    public NetworkManagementApiTests(TrafficSimApiFactory factory) => _factory = factory;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<ImportJobDto> ImportAsync(HttpClient client, double[] bbox, string? name)
    {
        var job = (await (await client.PostAsJsonAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new ImportRequest(bbox, null, name), Ct)).Content.ReadFromJsonAsync<ImportJobDto>(Ct))!;
        for (var i = 0; i < 100 && job.Status != "completed"; i++)
        {
            await Task.Delay(50, Ct);
            job = (await client.GetFromJsonAsync<ImportJobDto>(new Uri($"/api/v1/networks/import/{job.JobId}", UriKind.Relative), Ct))!;
        }

        return job;
    }

    [Fact]
    public async Task Imports_are_named_renamed_and_deleted_with_their_scenarios()
    {
        using var client = _factory.CreateClient();
        var job = await ImportAsync(client, [16.80, 48.20, 16.815, 48.21], "  Schwedenplatz  ");
        Assert.Equal("Schwedenplatz", job.Name);
        var id = job.BaselineId!.Value;
        Assert.Equal("Schwedenplatz", (await client.GetFromJsonAsync<NetworkBaselineDto>(new Uri($"/api/v1/networks/{id}", UriKind.Relative), Ct))!.Name);

        var renamed = await client.PatchAsJsonAsync(new Uri($"/api/v1/networks/{id}", UriKind.Relative), new RenameRequest("Donaukanal"), Ct);
        Assert.Equal("Donaukanal", (await renamed.Content.ReadFromJsonAsync<NetworkBaselineDto>(Ct))!.Name);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PatchAsJsonAsync(new Uri($"/api/v1/networks/{id}", UriKind.Relative), new RenameRequest(" "), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PatchAsJsonAsync(new Uri($"/api/v1/networks/{id}", UriKind.Relative), new RenameRequest(new string('x', 121)), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PatchAsJsonAsync(new Uri($"/api/v1/networks/{Guid.NewGuid()}", UriKind.Relative), new RenameRequest("x"), Ct)).StatusCode);

        var scenario = (await (await client.PostAsJsonAsync(new Uri("/api/v1/scenarios", UriKind.Relative), new ScenarioRequest("S", id, null, null, null, null), Ct)).Content.ReadFromJsonAsync<ScenarioDto>(Ct))!;

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync(new Uri($"/api/v1/networks/{id}", UriKind.Relative), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/networks/{id}", UriKind.Relative), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/scenarios/{scenario.Id}", UriKind.Relative), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync(new Uri($"/api/v1/networks/{id}", UriKind.Relative), Ct)).StatusCode);
    }

    [Fact]
    public async Task Reused_imports_take_the_name_when_they_had_none()
    {
        using var client = _factory.CreateClient();
        double[] bbox = [16.90, 48.20, 16.915, 48.21];
        var first = await ImportAsync(client, bbox, null);
        var second = await ImportAsync(client, bbox, "Later name");

        Assert.Equal(first.BaselineId, second.BaselineId);
        Assert.Equal("Later name", (await client.GetFromJsonAsync<NetworkBaselineDto>(new Uri($"/api/v1/networks/{first.BaselineId}", UriKind.Relative), Ct))!.Name);
        var tooLong = await client.PostAsJsonAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new ImportRequest(bbox, null, new string('n', 121)), Ct);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, tooLong.StatusCode);
    }
}
