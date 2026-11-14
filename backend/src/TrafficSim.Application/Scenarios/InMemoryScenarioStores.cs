using System.Collections.Concurrent;

namespace TrafficSim.Application.Scenarios;

public sealed class InMemoryScenarioStore : IScenarioStore
{
    private readonly ConcurrentDictionary<Guid, Scenario> _items = new();

    public Task SaveAsync(Scenario scenario, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        _items[scenario.Id] = scenario;
        return Task.CompletedTask;
    }

    public Task<Scenario?> GetAsync(Guid id, CancellationToken cancellationToken) => Task.FromResult(_items.GetValueOrDefault(id));

    public Task<Scenario?> GetByShareTokenAsync(string token, CancellationToken cancellationToken) =>
        Task.FromResult(_items.Values.FirstOrDefault(s => string.Equals(s.ShareToken, token, StringComparison.Ordinal)));

    public Task<IReadOnlyList<Scenario>> ListAsync(Guid? baselineId, int limit, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<Scenario>>(_items.Values
            .Where(s => baselineId is null || s.BaselineId == baselineId)
            .OrderByDescending(s => s.UpdatedAt)
            .Take(limit)
            .ToList());

    public Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken) => Task.FromResult(_items.TryRemove(id, out _));
}

public sealed class InMemoryRunStore : IRunStore
{
    private readonly ConcurrentDictionary<Guid, (SimulationRun Run, byte[] Buckets)> _items = new();

    public Task SaveAsync(SimulationRun run, byte[] buckets, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(run);
        _items[run.Id] = (run, buckets);
        return Task.CompletedTask;
    }

    public Task<SimulationRun?> GetAsync(Guid id, CancellationToken cancellationToken) =>
        Task.FromResult(_items.TryGetValue(id, out var item) ? item.Run : null);

    public Task<byte[]?> GetBucketsAsync(Guid id, CancellationToken cancellationToken) =>
        Task.FromResult(_items.TryGetValue(id, out var item) ? item.Buckets : null);

    public Task<IReadOnlyList<SimulationRun>> ListAsync(Guid scenarioId, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<SimulationRun>>(_items.Values.Select(i => i.Run).Where(r => r.ScenarioId == scenarioId).OrderByDescending(r => r.CreatedAt).ToList());
}
