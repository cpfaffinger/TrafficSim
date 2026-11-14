using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using TrafficSim.Api.Endpoints;
using TrafficSim.Domain.Editing;

namespace TrafficSim.Api.Tests;

public class ScenarioApiTests : IClassFixture<TrafficSimApiFactory>
{
    private readonly TrafficSimApiFactory _factory;

    public ScenarioApiTests(TrafficSimApiFactory factory) => _factory = factory;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private async Task<Guid> ImportAsync(HttpClient client, double offset)
    {
        double[] bbox = [16.36 + offset, 48.2, 16.375 + offset, 48.21];
        var response = await client.PostAsJsonAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new ImportRequest(bbox), Ct);
        var job = (await response.Content.ReadFromJsonAsync<ImportJobDto>(Ct))!;
        for (var i = 0; i < 100 && job.Status != "completed"; i++)
        {
            await Task.Delay(50, Ct);
            job = (await client.GetFromJsonAsync<ImportJobDto>(new Uri($"/api/v1/networks/import/{job.JobId}", UriKind.Relative), Ct))!;
        }

        Assert.Equal("completed", job.Status);
        return job.BaselineId!.Value;
    }

    [Fact]
    public async Task Scenario_lifecycle_with_changeset_variant_share_link_and_runs()
    {
        using var client = _factory.CreateClient();
        var baselineId = await ImportAsync(client, 0.1);
        EditOperation[] changeset = [new SetWayTags(10, null, null, new Dictionary<string, string?> { ["lanes"] = "4" })];
        var demand = JsonDocument.Parse("""{"entries":[{"node":"n0","vehiclesPerHour":600}]}""").RootElement;

        var created = await client.PostAsJsonAsync(new Uri("/api/v1/scenarios", UriKind.Relative),
            new ScenarioRequest("Widen main road", baselineId, [.. changeset], demand, 42, 1800), Json, Ct);
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var scenario = (await created.Content.ReadFromJsonAsync<ScenarioDto>(Json, Ct))!;
        Assert.Equal(42, scenario.Seed);
        Assert.NotNull(scenario.ShareToken);
        Assert.Equal(600, scenario.Demand!.Value.GetProperty("entries")[0].GetProperty("vehiclesPerHour").GetInt32());

        // Compiled package reflects the edit (2 lanes per direction).
        var package = await client.GetStringAsync(new Uri($"/api/v1/scenarios/{scenario.Id}/package", UriKind.Relative), Ct);
        using (var doc = JsonDocument.Parse(package))
        {
            Assert.All(doc.RootElement.GetProperty("links").EnumerateArray(), l => Assert.Equal(2, l.GetProperty("lanes").GetArrayLength()));
        }

        // Update, list, clone.
        var updated = await client.PutAsJsonAsync(new Uri($"/api/v1/scenarios/{scenario.Id}", UriKind.Relative), new ScenarioRequest("Renamed", null, null, null, null, null), Json, Ct);
        Assert.Equal("Renamed", (await updated.Content.ReadFromJsonAsync<ScenarioDto>(Json, Ct))!.Name);
        var list = await client.GetFromJsonAsync<List<ScenarioDto>>(new Uri($"/api/v1/scenarios?baselineId={baselineId}", UriKind.Relative), Json, Ct);
        Assert.Single(list!, s => s.Id == scenario.Id);
        Assert.Contains(list!, s => s.Name == "Weekday morning peak"); // generated at import (#115)
        var clone = await client.PostAsJsonAsync(new Uri($"/api/v1/scenarios/{scenario.Id}/clone", UriKind.Relative), new CloneRequest(null), Json, Ct);
        var variant = (await clone.Content.ReadFromJsonAsync<ScenarioDto>(Json, Ct))!;
        Assert.Equal(scenario.Id, variant.ParentId);
        Assert.Equal("Renamed (variant)", variant.Name);
        Assert.NotEqual(scenario.ShareToken, variant.ShareToken);

        // Read-only share link hides the token and serves the package.
        var shared = await client.GetFromJsonAsync<ScenarioDto>(new Uri($"/api/v1/shared/{scenario.ShareToken}", UriKind.Relative), Json, Ct);
        Assert.Null(shared!.ShareToken);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(new Uri($"/api/v1/shared/{scenario.ShareToken}/package", UriKind.Relative), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri("/api/v1/shared/not-a-token", UriKind.Relative), Ct)).StatusCode);

        // Runs.
        var summary = JsonDocument.Parse("""{"meanSpeed":11.2,"vehicles":420}""").RootElement;
        var run = await client.PostAsJsonAsync(new Uri($"/api/v1/scenarios/{scenario.Id}/runs", UriKind.Relative),
            new RunRequest(7, 1800, summary, "lane-cells-v1", Convert.ToBase64String([1, 2, 3, 4])), Json, Ct);
        Assert.Equal(HttpStatusCode.Created, run.StatusCode);
        var runDto = (await run.Content.ReadFromJsonAsync<RunDto>(Json, Ct))!;
        Assert.Equal(420, runDto.Summary.GetProperty("vehicles").GetInt32());
        Assert.Single((await client.GetFromJsonAsync<List<RunDto>>(new Uri($"/api/v1/scenarios/{scenario.Id}/runs", UriKind.Relative), Json, Ct))!);
        Assert.Equal(7, (await client.GetFromJsonAsync<RunDto>(new Uri($"/api/v1/runs/{runDto.Id}", UriKind.Relative), Json, Ct))!.Seed);
        Assert.Equal([1, 2, 3, 4], await client.GetByteArrayAsync(new Uri($"/api/v1/runs/{runDto.Id}/buckets", UriKind.Relative), Ct));

        // Delete.
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync(new Uri($"/api/v1/scenarios/{variant.Id}", UriKind.Relative), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync(new Uri($"/api/v1/scenarios/{variant.Id}", UriKind.Relative), Ct)).StatusCode);
    }

    [Fact]
    public async Task Preview_reports_issues_and_invalid_changesets_are_rejected()
    {
        using var client = _factory.CreateClient();
        var baselineId = await ImportAsync(client, 0.2);
        EditOperation[] bad = [new SetWayTags(999, null, null, new Dictionary<string, string?> { ["lanes"] = "2" })];

        var preview = await client.PostAsJsonAsync(new Uri($"/api/v1/networks/{baselineId}/preview", UriKind.Relative), new PreviewRequest([.. bad]), Json, Ct);
        Assert.Equal(HttpStatusCode.OK, preview.StatusCode);
        Assert.Equal("1", preview.Headers.GetValues(ScenarioEndpoints.IssuesHeader).Single());

        var create = await client.PostAsJsonAsync(new Uri("/api/v1/scenarios", UriKind.Relative), new ScenarioRequest("Bad", baselineId, [.. bad], null, null, null), Json, Ct);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, create.StatusCode);
        Assert.Contains("way 999 not found", await create.Content.ReadAsStringAsync(Ct), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("""{"name":"x"}""")]
    [InlineData("""{"name":"","baselineId":"00000000-0000-0000-0000-000000000001"}""")]
    public async Task Invalid_create_requests_are_rejected(string body)
    {
        using var client = _factory.CreateClient();

        var response = await client.PostAsync(new Uri("/api/v1/scenarios", UriKind.Relative), new StringContent(body, System.Text.Encoding.UTF8, "application/json"), Ct);

        Assert.True(response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.NotFound, response.StatusCode.ToString());
    }

    [Fact]
    public async Task Unknown_scenarios_and_runs_return_404_and_bad_runs_400()
    {
        using var client = _factory.CreateClient();
        var id = Guid.NewGuid();

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/scenarios/{id}", UriKind.Relative), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/runs/{id}", UriKind.Relative), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/runs/{id}/buckets", UriKind.Relative), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync(new Uri($"/api/v1/scenarios/{id}/clone", UriKind.Relative), new CloneRequest("x"), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/scenarios/{id}/package", UriKind.Relative), Ct)).StatusCode);
        var badRun = await client.PostAsJsonAsync(new Uri($"/api/v1/scenarios/{id}/runs", UriKind.Relative), new RunRequest(1, 1, null, "x", "%%%"), Ct);
        Assert.Equal(HttpStatusCode.BadRequest, badRun.StatusCode);
    }
}
