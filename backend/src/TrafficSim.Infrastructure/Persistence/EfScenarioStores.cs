using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TrafficSim.Application.Scenarios;
using TrafficSim.Domain.Editing;

namespace TrafficSim.Infrastructure.Persistence;

public sealed class EfScenarioStore(TrafficSimDbContext db) : IScenarioStore
{
    public async Task SaveAsync(Scenario scenario, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(scenario);
        var entity = await db.Set<ScenarioEntity>().FindAsync([scenario.Id], cancellationToken).ConfigureAwait(false);
        if (entity is null)
        {
            entity = new ScenarioEntity { Id = scenario.Id, Name = scenario.Name, Changeset = "[]", ShareToken = scenario.ShareToken };
            db.Add(entity);
        }

        entity.Name = scenario.Name;
        entity.BaselineId = scenario.BaselineId;
        entity.ParentId = scenario.ParentId;
        entity.Changeset = JsonSerializer.Serialize(scenario.Changeset, ScenarioService.JsonOptions);
        entity.Demand = scenario.DemandJson;
        entity.Seed = scenario.Seed;
        entity.DurationSeconds = scenario.DurationSeconds;
        entity.ShareToken = scenario.ShareToken;
        entity.CreatedAt = scenario.CreatedAt;
        entity.UpdatedAt = scenario.UpdatedAt;
        await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<Scenario?> GetAsync(Guid id, CancellationToken cancellationToken) =>
        ToDomain(await db.Set<ScenarioEntity>().AsNoTracking().FirstOrDefaultAsync(s => s.Id == id, cancellationToken).ConfigureAwait(false));

    public async Task<Scenario?> GetByShareTokenAsync(string token, CancellationToken cancellationToken) =>
        ToDomain(await db.Set<ScenarioEntity>().AsNoTracking().FirstOrDefaultAsync(s => s.ShareToken == token, cancellationToken).ConfigureAwait(false));

    public async Task<IReadOnlyList<Scenario>> ListAsync(Guid? baselineId, int limit, CancellationToken cancellationToken)
    {
        var query = db.Set<ScenarioEntity>().AsNoTracking();
        if (baselineId is { } b)
        {
            query = query.Where(s => s.BaselineId == b);
        }

        var rows = await query.OrderByDescending(s => s.UpdatedAt).Take(limit).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.Select(r => ToDomain(r)!).ToList();
    }

    public async Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken) =>
        await db.Set<ScenarioEntity>().Where(s => s.Id == id).ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false) > 0;

    private static Scenario? ToDomain(ScenarioEntity? e) => e is null
        ? null
        : new Scenario(
            e.Id, e.Name, e.BaselineId, e.ParentId,
            JsonSerializer.Deserialize<List<EditOperation>>(e.Changeset, ScenarioService.JsonOptions) ?? [],
            e.Demand, e.Seed, e.DurationSeconds, e.ShareToken, e.CreatedAt, e.UpdatedAt);
}

public sealed class EfRunStore(TrafficSimDbContext db) : IRunStore
{
    public async Task SaveAsync(SimulationRun run, byte[] buckets, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(run);
        db.Add(new RunEntity
        {
            Id = run.Id,
            ScenarioId = run.ScenarioId,
            Seed = run.Seed,
            SimulatedSeconds = run.SimulatedSeconds,
            Summary = run.SummaryJson,
            BucketFormat = run.BucketFormat,
            CreatedAt = run.CreatedAt,
            Buckets = buckets,
        });
        await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<SimulationRun?> GetAsync(Guid id, CancellationToken cancellationToken) =>
        await Runs().FirstOrDefaultAsync(r => r.Id == id, cancellationToken).ConfigureAwait(false);

    public Task<byte[]?> GetBucketsAsync(Guid id, CancellationToken cancellationToken) =>
        db.Set<RunEntity>().AsNoTracking().Where(r => r.Id == id).Select(r => (byte[]?)r.Buckets).FirstOrDefaultAsync(cancellationToken);

    public async Task<IReadOnlyList<SimulationRun>> ListAsync(Guid scenarioId, CancellationToken cancellationToken) =>
        await Runs().Where(r => r.ScenarioId == scenarioId).OrderByDescending(r => r.CreatedAt).ToListAsync(cancellationToken).ConfigureAwait(false);

    private IQueryable<SimulationRun> Runs() => db.Set<RunEntity>().AsNoTracking()
        .Select(r => new SimulationRun(r.Id, r.ScenarioId, r.Seed, r.SimulatedSeconds, r.Summary, r.BucketFormat, r.CreatedAt));
}
