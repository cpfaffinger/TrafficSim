using System.Text.Json;
using TrafficSim.Application.Batches;
using TrafficSim.Application.Scenarios;

namespace TrafficSim.Api.Endpoints;

public sealed record BatchRequest(int? Seeds, double? DurationSeconds, double? WarmupSeconds);

public sealed record BatchJobDto(Guid JobId, Guid ScenarioId, string Status, IReadOnlyList<long> Seeds, double DurationSeconds, IReadOnlyList<Guid> RunIds, JsonElement? Mean, string? Error)
{
    public static BatchJobDto From(BatchJob j)
    {
        ArgumentNullException.ThrowIfNull(j);
        return new(j.Id, j.ScenarioId, j.Status.ToString().ToLowerInvariant(), j.Seeds, j.DurationSeconds, j.RunIds,
            j.Mean is null ? null : JsonDocument.Parse(j.Mean).RootElement.Clone(), j.Error);
    }
}

internal static class BatchEndpoints
{
    public static RouteGroupBuilder MapBatchEndpoints(this RouteGroupBuilder group)
    {
        group.MapPost("/scenarios/{id:guid}/batch", StartAsync).WithName("StartBatch");
        group.MapGet("/batches/{jobId:guid}", (Guid jobId, BatchService service) =>
            service.Get(jobId) is { } job ? Results.Ok(BatchJobDto.From(job)) : Results.NotFound()).WithName("GetBatch");
        group.MapGet("/batch-runner", (IBatchRunner runner) => Results.Ok(new { available = runner.IsAvailable, maxSeeds = BatchService.MaxSeeds }))
            .WithName("GetBatchRunner");
        return group;
    }

    internal static async Task<IResult> StartAsync(Guid id, BatchRequest? request, BatchService service, CancellationToken ct)
    {
        try
        {
            var job = await service.StartAsync(id, request?.Seeds ?? 5, request?.DurationSeconds, request?.WarmupSeconds, ct).ConfigureAwait(false);
            return Results.Accepted($"/api/v1/batches/{job.Id}", BatchJobDto.From(job));
        }
        catch (BatchRunnerUnavailableException ex)
        {
            return Results.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "Batch runner unavailable", detail: ex.Message);
        }
        catch (NotFoundException ex)
        {
            return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Not found", detail: ex.Message);
        }
        catch (ArgumentException ex)
        {
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "Invalid batch request", detail: ex.Message);
        }
    }
}
