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
    IReadOnlyList<string> Attribution,
    GeoPolygon? Polygon = null,
    string? Name = null,
    string? AnalysisJson = null)
{
    /// <summary>The import area as a polygon (the bounds for rectangular imports).</summary>
    public GeoPolygon Shape => Polygon ?? GeoPolygon.FromBoundingBox(Area);
}

/// <summary>Port: persistent store of baselines and their network packages.</summary>
public interface INetworkBaselineStore
{
    Task SaveAsync(NetworkBaselineInfo info, byte[] gzipPackage, byte[]? gzipOsmData, CancellationToken cancellationToken);

    /// <summary>The raw OSM data of the baseline (gzip JSON, <see cref="OsmDataCodec"/>), needed to apply changesets.</summary>
    Task<byte[]?> GetOsmDataAsync(Guid id, CancellationToken cancellationToken);

    Task<NetworkBaselineInfo?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<byte[]?> GetPackageAsync(Guid id, CancellationToken cancellationToken);

    Task<IReadOnlyList<NetworkBaselineInfo>> ListAsync(int limit, CancellationToken cancellationToken);

    /// <summary>The newest baseline with exactly this area (and polygon, if any) created after <paramref name="since"/>.</summary>
    Task<NetworkBaselineInfo?> FindRecentAsync(BoundingBox area, GeoPolygon? polygon, DateTimeOffset since, CancellationToken cancellationToken);

    /// <summary>Renames a baseline; false when it does not exist.</summary>
    Task<bool> RenameAsync(Guid id, string name, CancellationToken cancellationToken);

    /// <summary>Deletes a baseline with its scenarios and runs; false when it does not exist.</summary>
    Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken);
}

/// <summary>Lifecycle of an import job.</summary>
public enum ImportStatus
{
    Queued,
    Fetching,
    Compiling,
    Storing,
    Generating,
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
    DateTimeOffset UpdatedAt,
    GeoPolygon? Polygon = null,
    string? Name = null,
    TrafficSim.Domain.Network.Compilation.RoadSelection Roads = TrafficSim.Domain.Network.Compilation.RoadSelection.All)
{
    public GeoPolygon Shape => Polygon ?? GeoPolygon.FromBoundingBox(Area);
}

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
