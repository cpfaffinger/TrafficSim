using TrafficSim.Domain.Editing;

namespace TrafficSim.Application.Scenarios;

/// <summary>
/// A what-if scenario (#72): a baseline plus a changeset, a demand definition (owned by the sim core,
/// stored as opaque JSON), a seed and a duration. Variants are clones with a parent.
/// </summary>
public sealed record Scenario(
    Guid Id,
    string Name,
    Guid BaselineId,
    Guid? ParentId,
    IReadOnlyList<EditOperation> Changeset,
    string? DemandJson,
    long Seed,
    double DurationSeconds,
    string ShareToken,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <summary>Aggregated results of one simulation run, uploaded by the browser (#61).</summary>
/// <param name="SummaryJson">KPIs as JSON (format owned by the sim core / frontend).</param>
/// <param name="BucketFormat">Identifier of the binary bucket layout, e.g. "lane-cells-v1".</param>
public sealed record SimulationRun(
    Guid Id,
    Guid ScenarioId,
    long Seed,
    double SimulatedSeconds,
    string SummaryJson,
    string BucketFormat,
    DateTimeOffset CreatedAt);

public interface IScenarioStore
{
    Task SaveAsync(Scenario scenario, CancellationToken cancellationToken);

    Task<Scenario?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<Scenario?> GetByShareTokenAsync(string token, CancellationToken cancellationToken);

    Task<IReadOnlyList<Scenario>> ListAsync(Guid? baselineId, int limit, CancellationToken cancellationToken);

    Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken);
}

public interface IRunStore
{
    Task SaveAsync(SimulationRun run, byte[] buckets, CancellationToken cancellationToken);

    Task<SimulationRun?> GetAsync(Guid id, CancellationToken cancellationToken);

    Task<byte[]?> GetBucketsAsync(Guid id, CancellationToken cancellationToken);

    Task<IReadOnlyList<SimulationRun>> ListAsync(Guid scenarioId, CancellationToken cancellationToken);
}
