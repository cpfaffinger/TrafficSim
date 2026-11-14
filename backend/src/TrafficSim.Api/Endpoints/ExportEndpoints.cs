using TrafficSim.Application.Exports;
using TrafficSim.Application.Scenarios;

namespace TrafficSim.Api.Endpoints;

internal static class ExportEndpoints
{
    public static RouteGroupBuilder MapExportEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/scenarios/{id:guid}/export/network.geojson", (Guid id, ExportService exports, CancellationToken ct) =>
            Guard(async () => File(await exports.NetworkGeoJsonAsync(id, ct).ConfigureAwait(false), "application/geo+json", "network.geojson")))
            .WithName("ExportNetworkGeoJson");
        group.MapGet("/runs/{id:guid}/export/links.geojson", (Guid id, ExportService exports, CancellationToken ct) =>
            Guard(async () => File(await exports.RunLinksGeoJsonAsync(id, ct).ConfigureAwait(false), "application/geo+json", "links.geojson")))
            .WithName("ExportRunLinksGeoJson");
        group.MapGet("/runs/{id:guid}/export/links.csv", (Guid id, ExportService exports, CancellationToken ct) =>
            Guard(async () => File(await exports.RunLinksCsvAsync(id, ct).ConfigureAwait(false), "text/csv", "links.csv")))
            .WithName("ExportRunLinksCsv");
        group.MapGet("/runs/{id:guid}/export/summary.csv", (Guid id, ExportService exports, CancellationToken ct) =>
            Guard(async () => File(await exports.RunSummaryCsvAsync(id, ct).ConfigureAwait(false), "text/csv", "summary.csv")))
            .WithName("ExportRunSummaryCsv");
        return group;
    }

    private static IResult File(string content, string contentType, string name) =>
        TypedResults.File(System.Text.Encoding.UTF8.GetBytes(content), contentType, name);

    private static async Task<IResult> Guard(Func<Task<IResult>> action)
    {
        try
        {
            return await action().ConfigureAwait(false);
        }
        catch (NotFoundException ex)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "Not found", detail: ex.Message);
        }
    }
}
