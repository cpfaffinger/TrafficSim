using Microsoft.Extensions.Logging;
using TrafficSim.Application.Providers;
using TrafficSim.Application.RoadSources;
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
    ILogger<NetworkImportService> logger)
{
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
    public async Task<ImportJob> StartAsync(BoundingBox requested, CancellationToken cancellationToken)
    {
        var area = Normalize(requested);
        var size = area.AreaSquareKilometers;
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
        var existing = await baselines.FindRecentAsync(area, now - ReuseWindow, cancellationToken).ConfigureAwait(false);
        var job = existing is null
            ? new ImportJob(Guid.NewGuid(), area, ImportStatus.Queued, null, null, now, now)
            : new ImportJob(Guid.NewGuid(), area, ImportStatus.Completed, existing.Id, null, now, now);
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
            var answer = await sources.FetchAsync(job.Area, cancellationToken).ConfigureAwait(false);

            job = await UpdateAsync(job, ImportStatus.Compiling, cancellationToken).ConfigureAwait(false);
            var network = NetworkCompiler.Compile(answer.Value, job.Area);

            job = await UpdateAsync(job, ImportStatus.Storing, cancellationToken).ConfigureAwait(false);
            var baselineId = Guid.NewGuid();
            var attribution = new[] { OsmAttribution, answer.Attribution }.Distinct(StringComparer.Ordinal).ToList();
            var package = NetworkPackageWriter.ToPackage(network, baselineId, attribution);
            var info = new NetworkBaselineInfo(baselineId, job.Area, time.GetUtcNow(), answer.Provider, answer.Value.DataTimestamp, package.Stats, attribution);
            await baselines.SaveAsync(info, NetworkPackageWriter.SerializeGzip(package), OsmDataCodec.Encode(answer.Value), cancellationToken).ConfigureAwait(false);

            await jobs.SaveAsync(job with { Status = ImportStatus.Completed, BaselineId = baselineId, UpdatedAt = time.GetUtcNow() }, cancellationToken).ConfigureAwait(false);
            LogImported(job.Id, baselineId, package.Stats.Links, answer.Provider);
        }
        catch (Exception ex) when (ex is NoProviderAvailableException or AreaTooLargeException or ArgumentException or InvalidOperationException)
        {
            LogFailed(job.Id, ex.Message);
            await jobs.SaveAsync(job with { Status = ImportStatus.Failed, Error = ex.Message, UpdatedAt = time.GetUtcNow() }, CancellationToken.None).ConfigureAwait(false);
        }
    }

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
