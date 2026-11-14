using TrafficSim.Domain.Geo;

namespace TrafficSim.Application.Networks;

/// <summary>Metadata of an immutable, compiled network baseline (ADR-0010).</summary>
public sealed record NetworkBaselineInfo(
    Guid Id,
    BoundingBox Area,
    DateTimeOffset CreatedAt,
    string Source,
    DateTimeOffset? OsmTimestamp,
    PackageStats Stats,
    IReadOnlyList<string> Attribution);

/// <summary>Port: persistent store of baselines and their network packages.</summary>
public interface INetworkBaselineStore
{
    Task SaveAsync(NetworkBaselineInfo info, byte[] gzipPackage, byte[]? gzipOsmData, CancellationToken cancellationToken);

    /// <summary>The raw OSM data of the baseline (gzip JSON, <see cref="OsmDataCodec"/>), needed to apply changesets.</summary>
    Task<byte[]?> GetOsmDataAsync(Guid id, CancellationToken cancellationToken);

    Task<NetworkBaselineInfo?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<byte[]?> GetPackageAsync(Guid id, CancellationToken cancellationToken);

    Task<IReadOnlyList<NetworkBaselineInfo>> ListAsync(int limit, CancellationToken cancellationToken);

    /// <summary>The newest baseline with exactly this area created after <paramref name="since"/>, if any.</summary>
    Task<NetworkBaselineInfo?> FindRecentAsync(BoundingBox area, DateTimeOffset since, CancellationToken cancellationToken);
}

/// <summary>Lifecycle of an import job.</summary>
public enum ImportStatus
{
    Queued,
    Fetching,
    Compiling,
    Storing,
    Completed,
    Failed,
}

/// <summary>An asynchronous network import.</summary>
public sealed record ImportJob(
    Guid Id,
    BoundingBox Area,
    ImportStatus Status,
    Guid? BaselineId,
    string? Error,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <summary>Port: import job state (short-lived; may be kept in memory).</summary>
public interface IImportJobStore
{
    Task SaveAsync(ImportJob job, CancellationToken cancellationToken);

    Task<ImportJob?> GetAsync(Guid id, CancellationToken cancellationToken);
}

/// <summary>Port: hands queued jobs to the background worker.</summary>
public interface IImportQueue
{
    ValueTask EnqueueAsync(Guid jobId, CancellationToken cancellationToken);

    IAsyncEnumerable<Guid> DequeueAllAsync(CancellationToken cancellationToken);
}
