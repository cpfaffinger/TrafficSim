using Microsoft.AspNetCore.Http.HttpResults;
using TrafficSim.Application.Networks;
using TrafficSim.Application.RoadSources;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Api.Endpoints;

/// <param name="Bbox">[west, south, east, north] for a rectangle, or</param>
/// <param name="Polygon">[[lon, lat], …] ring (WGS84) for any shape (#110).</param>
public sealed record ImportRequest(double[]? Bbox, double[][]? Polygon = null);

public sealed record ImportJobDto(Guid JobId, string Status, Guid? BaselineId, string? Error, double[] Bbox, double[][]? Polygon = null)
{
    public static ImportJobDto From(ImportJob job)
    {
        ArgumentNullException.ThrowIfNull(job);
        return new(job.Id, job.Status.ToString().ToLowerInvariant(), job.BaselineId, job.Error, ToArray(job.Area), Ring(job.Polygon));
    }

    internal static double[] ToArray(BoundingBox a) => [a.West, a.South, a.East, a.North];

    internal static double[][]? Ring(GeoPolygon? p) => p?.Ring.Select(v => new[] { v.Longitude, v.Latitude }).ToArray();
}

public sealed record NetworkBaselineDto(Guid Id, double[] Bbox, DateTimeOffset CreatedAt, string Source, DateTimeOffset? OsmTimestamp, PackageStats Stats, IReadOnlyList<string> Attribution, double[][]? Polygon = null)
{
    public static NetworkBaselineDto From(NetworkBaselineInfo i)
    {
        ArgumentNullException.ThrowIfNull(i);
        return new(i.Id, ImportJobDto.ToArray(i.Area), i.CreatedAt, i.Source, i.OsmTimestamp, i.Stats, i.Attribution, ImportJobDto.Ring(i.Polygon));
    }
}

internal static class NetworkEndpoints
{
    public static RouteGroupBuilder MapNetworkEndpoints(this RouteGroupBuilder group)
    {
        group.MapPost("/networks/import", ImportAsync).WithName("ImportNetwork");
        group.MapGet("/networks/import/{jobId:guid}", GetJobAsync).WithName("GetImportJob");
        group.MapGet("/networks", ListAsync).WithName("ListNetworks");
        group.MapGet("/networks/{id:guid}", GetAsync).WithName("GetNetwork");
        group.MapGet("/networks/{id:guid}/package", GetPackageAsync).WithName("GetNetworkPackage");
        return group;
    }

    internal static async Task<Results<Accepted<ImportJobDto>, Ok<ImportJobDto>, ProblemHttpResult>> ImportAsync(
        ImportRequest request, NetworkImportService service, CancellationToken cancellationToken)
    {
        GeoPolygon area;
        try
        {
            if (request?.Polygon is { } ring)
            {
                if (ring.Any(p => p is not { Length: 2 }))
                {
                    throw new ArgumentException("polygon must be [[lon, lat], …].");
                }

                area = new GeoPolygon(ring.Select(p => new GeoPoint(p[1], p[0])));
            }
            else if (request?.Bbox is { Length: 4 } b)
            {
                area = GeoPolygon.FromBoundingBox(new BoundingBox(b[1], b[0], b[3], b[2]));
            }
            else
            {
                throw new ArgumentException("Give bbox [west, south, east, north] or polygon [[lon, lat], …].");
            }
        }
        catch (ArgumentException ex)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: "Invalid area", detail: ex.Message);
        }

        try
        {
            var job = await service.StartAsync(area, cancellationToken).ConfigureAwait(false);
            var dto = ImportJobDto.From(job);
            return job.Status == ImportStatus.Completed
                ? TypedResults.Ok(dto)
                : TypedResults.Accepted($"/api/v1/networks/import/{job.Id}", dto);
        }
        catch (Exception ex) when (ex is AreaTooLargeException or InvalidImportAreaException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status422UnprocessableEntity, title: "Area not importable", detail: ex.Message);
        }
    }

    internal static async Task<Results<Ok<ImportJobDto>, NotFound>> GetJobAsync(Guid jobId, NetworkImportService service, CancellationToken cancellationToken) =>
        await service.GetJobAsync(jobId, cancellationToken).ConfigureAwait(false) is { } job
            ? TypedResults.Ok(ImportJobDto.From(job))
            : TypedResults.NotFound();

    internal static async Task<Ok<List<NetworkBaselineDto>>> ListAsync(int? limit, INetworkBaselineStore store, CancellationToken cancellationToken)
    {
        var items = await store.ListAsync(Math.Clamp(limit ?? 20, 1, 100), cancellationToken).ConfigureAwait(false);
        return TypedResults.Ok(items.Select(NetworkBaselineDto.From).ToList());
    }

    internal static async Task<Results<Ok<NetworkBaselineDto>, NotFound>> GetAsync(Guid id, INetworkBaselineStore store, CancellationToken cancellationToken) =>
        await store.GetAsync(id, cancellationToken).ConfigureAwait(false) is { } info
            ? TypedResults.Ok(NetworkBaselineDto.From(info))
            : TypedResults.NotFound();

    internal static async Task<IResult> GetPackageAsync(Guid id, HttpContext context, INetworkBaselineStore store, CancellationToken cancellationToken)
    {
        var gzip = await store.GetPackageAsync(id, cancellationToken).ConfigureAwait(false);
        if (gzip is null)
        {
            return TypedResults.NotFound();
        }

        // Baselines are immutable: cache aggressively.
        context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        return await GzipJsonAsync(context, gzip, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Serves gzip JSON as-is when the client accepts gzip, otherwise decompressed.</summary>
    internal static async Task<IResult> GzipJsonAsync(HttpContext context, byte[] gzip, CancellationToken cancellationToken)
    {
        context.Response.Headers.Vary = "Accept-Encoding";
        if (context.Request.Headers.AcceptEncoding.ToString().Contains("gzip", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.Headers.ContentEncoding = "gzip";
            return TypedResults.Bytes(gzip, "application/json");
        }

        using var input = new System.IO.Compression.GZipStream(new MemoryStream(gzip), System.IO.Compression.CompressionMode.Decompress);
        using var output = new MemoryStream();
        await input.CopyToAsync(output, cancellationToken).ConfigureAwait(false);
        return TypedResults.Bytes(output.ToArray(), "application/json");
    }
}
