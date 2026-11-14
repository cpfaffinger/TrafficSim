using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Application.Networks;

/// <summary>Job store kept in process memory (jobs are short-lived).</summary>
public sealed class InMemoryImportJobStore : IImportJobStore
{
    private readonly ConcurrentDictionary<Guid, ImportJob> _jobs = new();

    public Task SaveAsync(ImportJob job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        _jobs[job.Id] = job;
        return Task.CompletedTask;
    }

    public Task<ImportJob?> GetAsync(Guid id, CancellationToken cancellationToken) =>
        Task.FromResult(_jobs.TryGetValue(id, out var job) ? job : null);
}

/// <summary>Unbounded channel between the import API and the background worker.</summary>
public sealed class ChannelImportQueue : IImportQueue
{
    private readonly Channel<Guid> _channel = Channel.CreateUnbounded<Guid>(new UnboundedChannelOptions { SingleReader = true });

    public ValueTask EnqueueAsync(Guid jobId, CancellationToken cancellationToken) => _channel.Writer.WriteAsync(jobId, cancellationToken);

    public async IAsyncEnumerable<Guid> DequeueAllAsync([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (var id in _channel.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
        {
            yield return id;
        }
    }
}

/// <summary>Baseline store for development and tests without a database.</summary>
public sealed class InMemoryNetworkBaselineStore : INetworkBaselineStore
{
    private readonly ConcurrentDictionary<Guid, (NetworkBaselineInfo Info, byte[] Package, byte[]? Osm)> _items = new();

    public Task SaveAsync(NetworkBaselineInfo info, byte[] gzipPackage, byte[]? gzipOsmData, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(info);
        _items[info.Id] = (info, gzipPackage, gzipOsmData);
        return Task.CompletedTask;
    }

    public Task<bool> RenameAsync(Guid id, string name, CancellationToken cancellationToken)
    {
        if (!_items.TryGetValue(id, out var item))
        {
            return Task.FromResult(false);
        }

        _items[id] = item with { Info = item.Info with { Name = name } };
        return Task.FromResult(true);
    }

    public Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken) => Task.FromResult(_items.TryRemove(id, out _));

    public Task<byte[]?> GetOsmDataAsync(Guid id, CancellationToken cancellationToken) =>
        Task.FromResult(_items.TryGetValue(id, out var item) ? item.Osm : null);

    public Task<NetworkBaselineInfo?> GetAsync(Guid id, CancellationToken cancellationToken) =>
        Task.FromResult(_items.TryGetValue(id, out var item) ? item.Info : null);

    public Task<byte[]?> GetPackageAsync(Guid id, CancellationToken cancellationToken) =>
        Task.FromResult(_items.TryGetValue(id, out var item) ? item.Package : null);

    public Task<IReadOnlyList<NetworkBaselineInfo>> ListAsync(int limit, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<NetworkBaselineInfo>>(_items.Values.Select(i => i.Info).OrderByDescending(i => i.CreatedAt).Take(limit).ToList());

    public Task<NetworkBaselineInfo?> FindRecentAsync(BoundingBox area, GeoPolygon? polygon, DateTimeOffset since, CancellationToken cancellationToken) =>
        Task.FromResult(_items.Values.Select(i => i.Info)
            .Where(i => i.Area == area && Equals(i.Polygon, polygon) && i.CreatedAt >= since)
            .OrderByDescending(i => i.CreatedAt)
            .FirstOrDefault());
}
