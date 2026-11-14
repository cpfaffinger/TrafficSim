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
    private readonly ConcurrentDictionary<Guid, (NetworkBaselineInfo Info, byte[] Package)> _items = new();

    public Task SaveAsync(NetworkBaselineInfo info, byte[] gzipPackage, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(info);
        _items[info.Id] = (info, gzipPackage);
        return Task.CompletedTask;
    }

    public Task<NetworkBaselineInfo?> GetAsync(Guid id, CancellationToken cancellationToken) =>
        Task.FromResult(_items.TryGetValue(id, out var item) ? item.Info : null);

    public Task<byte[]?> GetPackageAsync(Guid id, CancellationToken cancellationToken) =>
        Task.FromResult(_items.TryGetValue(id, out var item) ? item.Package : null);

    public Task<IReadOnlyList<NetworkBaselineInfo>> ListAsync(int limit, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<NetworkBaselineInfo>>(_items.Values.Select(i => i.Info).OrderByDescending(i => i.CreatedAt).Take(limit).ToList());

    public Task<NetworkBaselineInfo?> FindRecentAsync(BoundingBox area, DateTimeOffset since, CancellationToken cancellationToken) =>
        Task.FromResult(_items.Values.Select(i => i.Info)
            .Where(i => i.Area == area && i.CreatedAt >= since)
            .OrderByDescending(i => i.CreatedAt)
            .FirstOrDefault());
}
