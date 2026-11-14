using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using TrafficSim.Api.Endpoints;

namespace TrafficSim.Api.Tests;

public class ExportApiTests : IClassFixture<TrafficSimApiFactory>
{
    private readonly TrafficSimApiFactory _factory;

    public ExportApiTests(TrafficSimApiFactory factory) => _factory = factory;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Exports_network_and_run_metrics_with_odbl_notice()
    {
        using var client = _factory.CreateClient();
        var job = (await (await client.PostAsJsonAsync(new Uri("/api/v1/networks/import", UriKind.Relative), new ImportRequest([16.5, 48.2, 16.515, 48.21]), Ct)).Content.ReadFromJsonAsync<ImportJobDto>(Ct))!;
        for (var i = 0; i < 100 && job.Status != "completed"; i++)
        {
            await Task.Delay(50, Ct);
            job = (await client.GetFromJsonAsync<ImportJobDto>(new Uri($"/api/v1/networks/import/{job.JobId}", UriKind.Relative), Ct))!;
        }

        var scenario = (await (await client.PostAsJsonAsync(new Uri("/api/v1/scenarios", UriKind.Relative),
            new ScenarioRequest("Export", job.BaselineId, null, null, null, null), Ct)).Content.ReadFromJsonAsync<ScenarioDto>(Ct))!;

        var geojson = await client.GetStringAsync(new Uri($"/api/v1/scenarios/{scenario.Id}/export/network.geojson", UriKind.Relative), Ct);
        using (var doc = JsonDocument.Parse(geojson))
        {
            Assert.Equal("FeatureCollection", doc.RootElement.GetProperty("type").GetString());
            Assert.Contains("ODbL", doc.RootElement.GetProperty("license").GetString(), StringComparison.Ordinal);
            var feature = doc.RootElement.GetProperty("features")[0];
            var lon = feature.GetProperty("geometry").GetProperty("coordinates")[0][0].GetDouble();
            Assert.InRange(lon, 16.5, 16.515);
        }

        var linkId = JsonDocument.Parse(geojson).RootElement.GetProperty("features")[0].GetProperty("properties").GetProperty("id").GetString();
        var summary = JsonDocument.Parse($$"""{"meanSpeed":10.5,"vehicles":{"arrived":12},"label":"a,b","links":[{"id":"{{linkId}}","meanSpeed":9.25,"flow":600},{"noId":1}]}""").RootElement;
        var run = (await (await client.PostAsJsonAsync(new Uri($"/api/v1/scenarios/{scenario.Id}/runs", UriKind.Relative),
            new RunRequest(1, 60, summary, "lane-cells-v1", ""), Ct)).Content.ReadFromJsonAsync<RunDto>(Ct))!;

        var csv = await client.GetStringAsync(new Uri($"/api/v1/runs/{run.Id}/export/links.csv", UriKind.Relative), Ct);
        Assert.StartsWith("# Contains information from OpenStreetMap", csv, StringComparison.Ordinal);
        Assert.Contains("flow,meanSpeed", csv, StringComparison.Ordinal);
        Assert.Contains(",600,9.25", csv, StringComparison.Ordinal);

        var linksGeo = await client.GetStringAsync(new Uri($"/api/v1/runs/{run.Id}/export/links.geojson", UriKind.Relative), Ct);
        Assert.Contains("\"flow\":600", linksGeo, StringComparison.Ordinal);

        var summaryCsv = await client.GetStringAsync(new Uri($"/api/v1/runs/{run.Id}/export/summary.csv", UriKind.Relative), Ct);
        Assert.Contains("vehicles.arrived,12", summaryCsv, StringComparison.Ordinal);
        Assert.Contains("label,\"a,b\"", summaryCsv, StringComparison.Ordinal);

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(new Uri($"/api/v1/runs/{Guid.NewGuid()}/export/links.csv", UriKind.Relative), Ct)).StatusCode);
    }
}
