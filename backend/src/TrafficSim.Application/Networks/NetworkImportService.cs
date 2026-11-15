using Microsoft.Extensions.Logging;
using TrafficSim.Application.Providers;
using System.Text.Json;
using TrafficSim.Application.RoadSources;
using TrafficSim.Application.Scenarios;
using TrafficSim.Domain.Activity;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Network.Compilation;

namespace TrafficSim.Application.Networks;

/// <summary>Raised for areas that cannot be imported (too small or invalid).</summary>
public sealed class InvalidImportAreaException : Exception
{
    public InvalidImportAreaException()
    {
    }

    public InvalidImportAreaException(string message)
        : base(message)
    {
    }

    public InvalidImportAreaException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>
/// Network import use case (#29): an area is fetched from the best road network source, compiled into
/// the lane graph and stored as an immutable baseline with its network package. Identical areas imported
/// within <see cref="ReuseWindow"/> reuse the existing baseline (idempotency).
/// </summary>
public sealed partial class NetworkImportService(
    RoadNetworkService sources,
    INetworkBaselineStore baselines,
    IImportJobStore jobs,
    IImportQueue queue,
    TimeProvider time,
    ILogger<NetworkImportService> logger,
    IEnumerable<IActivitySource>? activitySources = null,
    IScenarioStore? scenarios = null,
    TerrainService? terrain = null)
{
    private readonly IReadOnlyList<IActivitySource> _activitySources = ProviderFallback.Order(activitySources ?? []);
    public const double MinAreaSquareKilometers = 0.01;
    public const string OsmAttribution = "© OpenStreetMap contributors (ODbL)";
    public static readonly TimeSpan ReuseWindow = TimeSpan.FromHours(24);

    private readonly ILogger<NetworkImportService> _logger = logger;

    /// <summary>Normalises the area (5 decimals ≈ 1 m) so identical requests match.</summary>
    public static BoundingBox Normalize(BoundingBox area)
    {
        ArgumentNullException.ThrowIfNull(area);
        return new BoundingBox(Math.Round(area.South, 5), Math.Round(area.West, 5), Math.Round(area.North, 5), Math.Round(area.East, 5));
    }

    /// <exception cref="InvalidImportAreaException">The area is too small.</exception>
    /// <exception cref="AreaTooLargeException">No source accepts an area this large.</exception>
    public const int MaxNameLength = 120;

    public Task<ImportJob> StartAsync(BoundingBox requested, CancellationToken cancellationToken) =>
        StartAsync(GeoPolygon.FromBoundingBox(Normalize(requested)), null, cancellationToken);

    public Task<ImportJob> StartAsync(GeoPolygon requested, CancellationToken cancellationToken) => StartAsync(requested, null, cancellationToken);

    /// <summary>Trimmed name, null when empty; throws when too long.</summary>
    public static string? CleanName(string? name)
    {
        var trimmed = name?.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return null;
        }

        return trimmed.Length <= MaxNameLength ? trimmed : throw new InvalidImportAreaException($"The name must not exceed {MaxNameLength} characters.");
    }

    /// <summary>Starts the import of a polygon area (#110); rectangles are stored as plain bounds.</summary>
    public Task<ImportJob> StartAsync(GeoPolygon requested, string? name, CancellationToken cancellationToken) =>
        StartAsync(requested, name, RoadSelection.All, cancellationToken);

    /// <summary>Starts an import that keeps only the selected road classes (#131).</summary>
    public async Task<ImportJob> StartAsync(GeoPolygon requested, string? name, RoadSelection roads, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(requested);
        name = CleanName(name);
        var shape = requested.Normalize();
        var polygon = shape.IsRectangle ? null : shape;
        var area = polygon is null ? Normalize(shape.Bounds) : shape.Bounds;
        var size = shape.AreaSquareKilometers;
        if (size < MinAreaSquareKilometers)
        {
            throw new InvalidImportAreaException(FormattableString.Invariant($"Area of {size:F4} km² is below the minimum of {MinAreaSquareKilometers} km²."));
        }

        if (size > sources.MaxAreaSquareKilometers)
        {
            throw new AreaTooLargeException(FormattableString.Invariant(
                $"Area of {size:F1} km² exceeds the largest supported area of {sources.MaxAreaSquareKilometers:F0} km²."));
        }

        var now = time.GetUtcNow();
        // A recent import of the same area is reused only for the full network (stored imports do not
        // record a road selection).
        var existing = roads == RoadSelection.All
            ? await baselines.FindRecentAsync(area, polygon, now - ReuseWindow, cancellationToken).ConfigureAwait(false)
            : null;
        var job = existing is null
            ? new ImportJob(Guid.NewGuid(), area, ImportStatus.Queued, null, null, now, now, polygon, name, roads)
            : new ImportJob(Guid.NewGuid(), area, ImportStatus.Completed, existing.Id, null, now, now, polygon, name);
        if (existing is not null && name is not null && existing.Name is null)
        {
            await baselines.RenameAsync(existing.Id, name, cancellationToken).ConfigureAwait(false);
        }
        await jobs.SaveAsync(job, cancellationToken).ConfigureAwait(false);
        if (existing is null)
        {
            await queue.EnqueueAsync(job.Id, cancellationToken).ConfigureAwait(false);
        }

        return job;
    }

    public Task<ImportJob?> GetJobAsync(Guid id, CancellationToken cancellationToken) => jobs.GetAsync(id, cancellationToken);

    /// <summary>Executes a queued job; failures are recorded on the job, never thrown.</summary>
    public async Task RunAsync(Guid jobId, CancellationToken cancellationToken)
    {
        var job = await jobs.GetAsync(jobId, cancellationToken).ConfigureAwait(false);
        if (job is null || job.Status != ImportStatus.Queued)
        {
            return;
        }

        try
        {
            job = await UpdateAsync(job, ImportStatus.Fetching, cancellationToken).ConfigureAwait(false);
            var answer = await sources.FetchAsync(job.Shape, cancellationToken).ConfigureAwait(false);

            // Terrain is optional (ADR-0018): without it the network stays flat.
            var ground = terrain is null ? null : await terrain.SampleAsync(job.Shape, cancellationToken).ConfigureAwait(false);

            job = await UpdateAsync(job, ImportStatus.Compiling, cancellationToken).ConfigureAwait(false);
            var network = NetworkCompiler.Compile(answer.Value, job.Shape, new CompilerOptions { Terrain = ground?.Grid, Roads = job.Roads });

            job = await UpdateAsync(job, ImportStatus.Storing, cancellationToken).ConfigureAwait(false);
            var baselineId = Guid.NewGuid();
            var attribution = new[] { OsmAttribution, answer.Attribution, ground?.Attribution }
                .OfType<string>().Distinct(StringComparer.Ordinal).ToList();
            var package = NetworkPackageWriter.ToPackage(network, baselineId, attribution);
            job = await UpdateAsync(job, ImportStatus.Generating, cancellationToken).ConfigureAwait(false);
            var pois = await FetchActivityAsync(job.Shape, cancellationToken).ConfigureAwait(false);
            var (generated, summary) = ScenarioGenerator.Generate(package, pois, job.Shape.AreaSquareKilometers);
            var analysis = JsonSerializer.Serialize(summary, ScenarioService.JsonOptions);

            var info = new NetworkBaselineInfo(baselineId, job.Area, time.GetUtcNow(), answer.Provider, answer.Value.DataTimestamp, package.Stats, attribution, job.Polygon, job.Name, analysis);
            await baselines.SaveAsync(info, NetworkPackageWriter.SerializeGzip(package), OsmDataCodec.Encode(answer.Value), cancellationToken).ConfigureAwait(false);
            await CreateScenariosAsync(baselineId, generated, cancellationToken).ConfigureAwait(false);

            await jobs.SaveAsync(job with { Status = ImportStatus.Completed, BaselineId = baselineId, UpdatedAt = time.GetUtcNow() }, cancellationToken).ConfigureAwait(false);
            LogImported(job.Id, baselineId, package.Stats.Links, answer.Provider);
        }
        catch (Exception ex) when (ex is NoProviderAvailableException or AreaTooLargeException or ArgumentException or InvalidOperationException)
        {
            LogFailed(job.Id, ex.Message);
            await jobs.SaveAsync(job with { Status = ImportStatus.Failed, Error = ex.Message, UpdatedAt = time.GetUtcNow() }, CancellationToken.None).ConfigureAwait(false);
        }
    }

    /// <summary>Buildings, land use and POIs for scenario generation; an import never fails because of them.</summary>
    private async Task<IReadOnlyList<OsmPoi>> FetchActivityAsync(GeoPolygon area, CancellationToken cancellationToken)
    {
        var size = area.AreaSquareKilometers;
        foreach (var source in _activitySources.Where(s => s.MaxAreaSquareKilometers >= size))
        {
            try
            {
                return await source.FetchAsync(area, cancellationToken).ConfigureAwait(false);
            }
            catch (ProviderUnavailableException ex)
            {
                LogActivityFailed(source.Name, ex.Message);
            }
        }

        return [];
    }

    private async Task CreateScenariosAsync(Guid baselineId, IReadOnlyList<GeneratedScenario> generated, CancellationToken cancellationToken)
    {
        if (scenarios is null)
        {
            return;
        }

        foreach (var g in generated)
        {
            var now = time.GetUtcNow();
            var scenario = new Scenario(Guid.NewGuid(), g.Name, baselineId, null, [], g.DemandJson, 1, g.DurationSeconds, ScenarioService.NewShareToken(), now, now);
            await scenarios.SaveAsync(scenario, cancellationToken).ConfigureAwait(false);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Activity source {Source} failed, scenarios use road-class profiles only: {Reason}")]
    private partial void LogActivityFailed(string source, string reason);

    private async Task<ImportJob> UpdateAsync(ImportJob job, ImportStatus status, CancellationToken cancellationToken)
    {
        var updated = job with { Status = status, UpdatedAt = time.GetUtcNow() };
        await jobs.SaveAsync(updated, cancellationToken).ConfigureAwait(false);
        return updated;
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Import {JobId} stored baseline {BaselineId} with {Links} links from {Provider}")]
    private partial void LogImported(Guid jobId, Guid baselineId, int links, string provider);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Import {JobId} failed: {Reason}")]
    private partial void LogFailed(Guid jobId, string reason);
}
