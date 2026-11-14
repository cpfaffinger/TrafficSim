using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TrafficSim.Api.Endpoints;
using TrafficSim.Application.Batches;

namespace TrafficSim.Api.Tests;

/// <summary>Echoes a plausible runner result: one run per seed with a summary and a small cells blob.</summary>
public sealed class FakeBatchRunner : IBatchRunner
{
    public bool IsAvailable { get; set; } = true;

    public string? LastConfig { get; private set; }

    public Task<BatchRunnerResult> RunAsync(string packageJson, string configJson, IReadOnlyList<long> seeds, double durationSeconds, double warmupSeconds, CancellationToken cancellationToken)
    {
        LastConfig = configJson;
        var runs = string.Join(',', seeds.Select(s =>
            "{\"seed\":" + s + ",\"checksum\":\"x\",\"summary\":{\"network\":{\"meanSpeed\":" + (8 + s) + "},\"links\":[]}}"));
        var json = "{\"formatVersion\":1,\"seeds\":[" + string.Join(',', seeds) + "],\"network\":{\"meanSpeed\":9.5},\"links\":[],\"runs\":[" + runs + "]}";
        return Task.FromResult(new BatchRunnerResult(json, seeds.ToDictionary(s => s, s => new byte[] { 1, (byte)s })));
    }
}

public class BatchApiTests : IClassFixture<TrafficSimApiFactory>
{
    private readonly TrafficSimApiFactory _factory;

    public BatchApiTests(TrafficSimApiFactory factory) => _factory = factory;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private HttpClient Client(FakeBatchRunner runner) => _factory.WithWebHostBuilder(b => b.ConfigureServices(s =>
    {
        s.RemoveAll<IBatchRunner>();
        s.AddSingleton<IBatchRunner>(runner);
    })).CreateClient();

    private static async Task<Guid> ScenarioAsync(HttpClient client)
    {
        var job = (await (await client.PostAsJsonAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new ImportRequest([16.6, 48.3, 16.615, 48.31]), Ct)).Content.ReadFromJsonAsync<ImportJobDto>(Ct))!;
        for (var i = 0; i < 100 && job.Status != "completed"; i++)
        {
            await Task.Delay(50, Ct);
            job = (await client.GetFromJsonAsync<ImportJobDto>(new Uri($"/api/v1/networks/import/{job.JobId}", UriKind.Relative), Ct))!;
        }

        var list = await client.GetFromJsonAsync<List<ScenarioDto>>(new Uri($"/api/v1/scenarios?baselineId={job.BaselineId}", UriKind.Relative), Ct);
        return list!.First(s => s.Name == "Weekday morning peak").Id;
    }

    [Fact]
    public async Task Batch_runs_store_one_run_per_seed()
    {
        var runner = new FakeBatchRunner();
        using var client = Client(runner);
        var scenarioId = await ScenarioAsync(client);

        Assert.True((await client.GetFromJsonAsync<JsonElement>(new Uri("/api/v1/batch-runner", UriKind.Relative), Ct)).GetProperty("available").GetBoolean());
        var response = await client.PostAsJsonAsync(new Uri($"/api/v1/scenarios/{scenarioId}/batch", UriKind.Relative), new BatchRequest(3, 600, 60), Ct);
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        var job = (await response.Content.ReadFromJsonAsync<BatchJobDto>(Ct))!;
        for (var i = 0; i < 100 && job.Status is "queued" or "running"; i++)
        {
            await Task.Delay(50, Ct);
            job = (await client.GetFromJsonAsync<BatchJobDto>(new Uri($"/api/v1/batches/{job.JobId}", UriKind.Relative), Ct))!;
        }

        Assert.Equal("completed", job.Status);
        Assert.Equal([1L, 2L, 3L], job.Seeds);
        Assert.Equal(3, job.RunIds.Count);
        Assert.Equal(9.5, job.Mean!.Value.GetProperty("meanSpeed").GetDouble());
        Assert.Contains("\"od\"", runner.LastConfig, StringComparison.Ordinal);
        var runs = await client.GetFromJsonAsync<List<RunDto>>(new Uri($"/api/v1/scenarios/{scenarioId}/runs", UriKind.Relative), Ct);
        Assert.Equal(3, runs!.Count);
        Assert.All(runs, r => Assert.Equal("lane-cells-v1", r.BucketFormat));
        Assert.Equal([1, 2], await client.GetByteArrayAsync(new Uri($"/api/v1/runs/{runs.Single(r => r.Seed == 2).Id}/buckets", UriKind.Relative), Ct));
    }

    [Fact]
    public async Task Invalid_requests_and_missing_runner()
    {
        using var client = Client(new FakeBatchRunner());
        var scenarioId = await ScenarioAsync(client);

        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync(new Uri($"/api/v1/scenarios/{scenarioId}/batch", UriKind.Relative), new BatchRequest(50, null, null), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync(new Uri($"/api/v1/scenarios/{scenarioId}/batch", UriKind.Relative), new BatchRequest(2, -1, null), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync(new Uri($"/api/v1/scenarios/{Guid.NewGuid()}/batch", UriKind.Relative), new BatchRequest(2, null, null), Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/batches/{Guid.NewGuid()}", UriKind.Relative), Ct)).StatusCode);

        using var noRunner = Client(new FakeBatchRunner { IsAvailable = false });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await noRunner.PostAsJsonAsync(new Uri($"/api/v1/scenarios/{scenarioId}/batch", UriKind.Relative), new BatchRequest(2, null, null), Ct)).StatusCode);
    }
}
