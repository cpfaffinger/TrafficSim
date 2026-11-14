using System.Text.Json;
using Microsoft.AspNetCore.Http.HttpResults;
using TrafficSim.Application.Scenarios;
using TrafficSim.Domain.Editing;

namespace TrafficSim.Api.Endpoints;

public sealed record ScenarioRequest(string? Name, Guid? BaselineId, List<EditOperation>? Changeset, JsonElement? Demand, long? Seed, double? DurationSeconds);

public sealed record CloneRequest(string? Name);

public sealed record PreviewRequest(List<EditOperation>? Changeset);

public sealed record RunRequest(long Seed, double SimulatedSeconds, JsonElement? Summary, string? BucketFormat, string? Buckets);

public sealed record ScenarioDto(Guid Id, string Name, Guid BaselineId, Guid? ParentId, IReadOnlyList<EditOperation> Changeset, JsonElement? Demand, long Seed, double DurationSeconds, string? ShareToken, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt)
{
    public static ScenarioDto From(Scenario s, bool includeToken)
    {
        ArgumentNullException.ThrowIfNull(s);
        JsonElement? demand = s.DemandJson is null ? null : JsonDocument.Parse(s.DemandJson).RootElement.Clone();
        return new(s.Id, s.Name, s.BaselineId, s.ParentId, s.Changeset, demand, s.Seed, s.DurationSeconds, includeToken ? s.ShareToken : null, s.CreatedAt, s.UpdatedAt);
    }
}

public sealed record RunDto(Guid Id, Guid ScenarioId, long Seed, double SimulatedSeconds, JsonElement Summary, string BucketFormat, DateTimeOffset CreatedAt)
{
    public static RunDto From(SimulationRun r)
    {
        ArgumentNullException.ThrowIfNull(r);
        return new(r.Id, r.ScenarioId, r.Seed, r.SimulatedSeconds, JsonDocument.Parse(r.SummaryJson).RootElement.Clone(), r.BucketFormat, r.CreatedAt);
    }
}

public sealed record EditIssueDto(int OperationIndex, string Operation, string Message);

internal static class ScenarioEndpoints
{
    public const string IssuesHeader = "X-TrafficSim-Edit-Issues";

    public static RouteGroupBuilder MapScenarioEndpoints(this RouteGroupBuilder group)
    {
        group.MapPost("/scenarios", CreateAsync).WithName("CreateScenario");
        group.MapGet("/scenarios", ListAsync).WithName("ListScenarios");
        group.MapGet("/scenarios/{id:guid}", GetAsync).WithName("GetScenario");
        group.MapPut("/scenarios/{id:guid}", UpdateAsync).WithName("UpdateScenario");
        group.MapDelete("/scenarios/{id:guid}", DeleteAsync).WithName("DeleteScenario");
        group.MapPost("/scenarios/{id:guid}/clone", CloneAsync).WithName("CloneScenario");
        group.MapGet("/scenarios/{id:guid}/package", PackageAsync).WithName("GetScenarioPackage");
        group.MapPost("/networks/{id:guid}/preview", PreviewAsync).WithName("PreviewChangeset");
        group.MapPost("/scenarios/{id:guid}/runs", AddRunAsync).WithName("AddRun");
        group.MapGet("/scenarios/{id:guid}/runs", ListRunsAsync).WithName("ListRuns");
        group.MapGet("/runs/{id:guid}", GetRunAsync).WithName("GetRun");
        group.MapGet("/runs/{id:guid}/buckets", GetRunBucketsAsync).WithName("GetRunBuckets");
        group.MapGet("/shared/{token}", SharedAsync).WithName("GetSharedScenario");
        group.MapGet("/shared/{token}/package", SharedPackageAsync).WithName("GetSharedScenarioPackage");
        return group;
    }

    internal static Task<IResult> CreateAsync(ScenarioRequest request, ScenarioService service, CancellationToken ct) => Guard(async () =>
    {
        if (request.BaselineId is not { } baselineId)
        {
            throw new ArgumentException("baselineId is required");
        }

        var s = await service.CreateAsync(request.Name ?? "Scenario", baselineId, request.Changeset, Raw(request.Demand), request.Seed, request.DurationSeconds, ct).ConfigureAwait(false);
        return TypedResults.Created($"/api/v1/scenarios/{s.Id}", ScenarioDto.From(s, includeToken: true));
    });

    internal static async Task<Ok<List<ScenarioDto>>> ListAsync(Guid? baselineId, int? limit, ScenarioService service, CancellationToken ct)
    {
        var items = await service.ListAsync(baselineId, limit ?? 50, ct).ConfigureAwait(false);
        return TypedResults.Ok(items.Select(s => ScenarioDto.From(s, includeToken: true)).ToList());
    }

    internal static Task<IResult> GetAsync(Guid id, ScenarioService service, CancellationToken ct) =>
        Guard(async () => TypedResults.Ok(ScenarioDto.From(await service.GetAsync(id, ct).ConfigureAwait(false), includeToken: true)));

    internal static Task<IResult> UpdateAsync(Guid id, ScenarioRequest request, ScenarioService service, CancellationToken ct) =>
        Guard(async () => TypedResults.Ok(ScenarioDto.From(
            await service.UpdateAsync(id, request.Name, request.Changeset, Raw(request.Demand), request.Seed, request.DurationSeconds, ct).ConfigureAwait(false), includeToken: true)));

    internal static async Task<Results<NoContent, NotFound>> DeleteAsync(Guid id, ScenarioService service, CancellationToken ct) =>
        await service.DeleteAsync(id, ct).ConfigureAwait(false) ? TypedResults.NoContent() : TypedResults.NotFound();

    internal static Task<IResult> CloneAsync(Guid id, CloneRequest? request, ScenarioService service, CancellationToken ct) => Guard(async () =>
    {
        var s = await service.CloneAsync(id, request?.Name, ct).ConfigureAwait(false);
        return TypedResults.Created($"/api/v1/scenarios/{s.Id}", ScenarioDto.From(s, includeToken: true));
    });

    internal static Task<IResult> PackageAsync(Guid id, HttpContext context, ScenarioService service, CancellationToken ct) => Guard(async () =>
    {
        var s = await service.GetAsync(id, ct).ConfigureAwait(false);
        var compiled = await service.CompileAsync(s.BaselineId, s.Changeset, ct).ConfigureAwait(false);
        return await WritePackageAsync(context, compiled, ct).ConfigureAwait(false);
    });

    internal static Task<IResult> PreviewAsync(Guid id, PreviewRequest request, HttpContext context, ScenarioService service, CancellationToken ct) => Guard(async () =>
    {
        var compiled = await service.CompileAsync(id, request.Changeset ?? [], ct).ConfigureAwait(false);
        return await WritePackageAsync(context, compiled, ct).ConfigureAwait(false);
    });

    internal static Task<IResult> AddRunAsync(Guid id, RunRequest request, ScenarioService service, CancellationToken ct) => Guard(async () =>
    {
        byte[] buckets;
        try
        {
            buckets = Convert.FromBase64String(request.Buckets ?? string.Empty);
        }
        catch (FormatException ex)
        {
            throw new ArgumentException("buckets must be base64", ex);
        }

        var run = await service.AddRunAsync(id, request.Seed, request.SimulatedSeconds, Raw(request.Summary) ?? "{}", request.BucketFormat ?? string.Empty, buckets, ct).ConfigureAwait(false);
        return TypedResults.Created($"/api/v1/runs/{run.Id}", RunDto.From(run));
    });

    internal static async Task<Ok<List<RunDto>>> ListRunsAsync(Guid id, ScenarioService service, CancellationToken ct) =>
        TypedResults.Ok((await service.ListRunsAsync(id, ct).ConfigureAwait(false)).Select(RunDto.From).ToList());

    internal static Task<IResult> GetRunAsync(Guid id, ScenarioService service, CancellationToken ct) =>
        Guard(async () => TypedResults.Ok(RunDto.From(await service.GetRunAsync(id, ct).ConfigureAwait(false))));

    internal static Task<IResult> GetRunBucketsAsync(Guid id, ScenarioService service, CancellationToken ct) =>
        Guard(async () => TypedResults.Bytes(await service.GetRunBucketsAsync(id, ct).ConfigureAwait(false), "application/octet-stream"));

    internal static Task<IResult> SharedAsync(string token, ScenarioService service, CancellationToken ct) =>
        Guard(async () => TypedResults.Ok(ScenarioDto.From(await service.GetSharedAsync(token, ct).ConfigureAwait(false), includeToken: false)));

    internal static Task<IResult> SharedPackageAsync(string token, HttpContext context, ScenarioService service, CancellationToken ct) => Guard(async () =>
    {
        var s = await service.GetSharedAsync(token, ct).ConfigureAwait(false);
        return await WritePackageAsync(context, await service.CompileAsync(s.BaselineId, s.Changeset, ct).ConfigureAwait(false), ct).ConfigureAwait(false);
    });

    private static Task<IResult> WritePackageAsync(HttpContext context, CompiledNetwork compiled, CancellationToken ct)
    {
        context.Response.Headers[IssuesHeader] = compiled.Issues.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (compiled.Issues.Count > 0)
        {
            context.Response.Headers["X-TrafficSim-Edit-Issue-List"] = Uri.EscapeDataString(JsonSerializer.Serialize(
                compiled.Issues.Select(i => new EditIssueDto(i.OperationIndex, i.Operation, i.Message)), ScenarioService.JsonOptions));
        }

        return NetworkEndpoints.GzipJsonAsync(context, compiled.GzipPackage, ct);
    }

    private static string? Raw(JsonElement? element) =>
        element is { ValueKind: not (JsonValueKind.Undefined or JsonValueKind.Null) } e ? e.GetRawText() : null;

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
        catch (ChangesetValidationException ex)
        {
            return TypedResults.Problem(
                statusCode: StatusCodes.Status422UnprocessableEntity,
                title: "Changeset cannot be applied",
                detail: ex.Message,
                extensions: new Dictionary<string, object?> { ["issues"] = ex.Issues.Select(i => new EditIssueDto(i.OperationIndex, i.Operation, i.Message)).ToList() });
        }
        catch (ArgumentException ex)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: "Invalid request", detail: ex.Message);
        }
    }
}
