using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Microsoft.Extensions.Logging;
using TrafficSim.Application.Networks;
using TrafficSim.Application.Scenarios;

namespace TrafficSim.Application.Batches;

/// <summary>Result of one native batch invocation (#84).</summary>
/// <param name="ResultJson">The runner's JSON output (seeds, mean KPIs, per-run summaries).</param>
/// <param name="CellsBySeed">lane-cells-v1 blobs per seed.</param>
public sealed record BatchRunnerResult(string ResultJson, IReadOnlyDictionary<long, byte[]> CellsBySeed);

/// <summary>Port: runs the headless simulation for several seeds (native sim-core binary).</summary>
public interface IBatchRunner
{
    bool IsAvailable { get; }

    Task<BatchRunnerResult> RunAsync(string packageJson, string configJson, IReadOnlyList<long> seeds, double durationSeconds, double warmupSeconds, CancellationToken cancellationToken);
}

/// <summary>Raised when no batch runner is installed in this deployment.</summary>
public sealed class BatchRunnerUnavailableException : Exception
{
    public BatchRunnerUnavailableException()
        : base("The native batch runner is not installed.")
    {
    }

    public BatchRunnerUnavailableException(string message)
        : base(message)
    {
    }

    public BatchRunnerUnavailableException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

public enum BatchStatus
{
    Queued,
    Running,
    Completed,
    Failed,
}

/// <summary>A multi-seed batch for one scenario (#73).</summary>
/// <param name="Mean">Mean network KPIs over all seeds (runner output), when completed.</param>
public sealed record BatchJob(
    Guid Id,
    Guid ScenarioId,
    IReadOnlyList<long> Seeds,
    double DurationSeconds,
    double WarmupSeconds,
    BatchStatus Status,
    IReadOnlyList<Guid> RunIds,
    string? Mean,
    string? Error,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <summary>Batch jobs are short-lived and kept in memory; their runs are persisted.</summary>
public sealed class BatchJobStore
{
    private readonly ConcurrentDictionary<Guid, BatchJob> _jobs = new();

    public void Save(BatchJob job)
    {
        ArgumentNullException.ThrowIfNull(job);
        _jobs[job.Id] = job;
    }

    public BatchJob? Get(Guid id) => _jobs.GetValueOrDefault(id);
}

public sealed class BatchQueue
{
    private readonly Channel<Guid> _channel = Channel.CreateUnbounded<Guid>(new UnboundedChannelOptions { SingleReader = true });

    public ValueTask EnqueueAsync(Guid id, CancellationToken cancellationToken) => _channel.Writer.WriteAsync(id, cancellationToken);

    public IAsyncEnumerable<Guid> DequeueAllAsync(CancellationToken cancellationToken) => _channel.Reader.ReadAllAsync(cancellationToken);
}

/// <summary>
/// Server-side batch runs (#73, #84): compiles the scenario's network, runs the native sim core for N
/// seeds and stores every seed as a <see cref="SimulationRun"/> with its summary and lane-cell buckets.
/// </summary>
public sealed partial class BatchService(
    ScenarioService scenarios,
    IBatchRunner runner,
    BatchJobStore jobs,
    BatchQueue queue,
    TimeProvider time,
    ILogger<BatchService> logger)
{
    public const int MaxSeeds = 20;
    public const double MaxDurationSeconds = 6 * 3600;
    private readonly ILogger<BatchService> _logger = logger;

    public async Task<BatchJob> StartAsync(Guid scenarioId, int seedCount, double? durationSeconds, double? warmupSeconds, CancellationToken cancellationToken)
    {
        if (!runner.IsAvailable)
        {
            throw new BatchRunnerUnavailableException();
        }

        var scenario = await scenarios.GetAsync(scenarioId, cancellationToken).ConfigureAwait(false);
        if (seedCount is < 1 or > MaxSeeds)
        {
            throw new ArgumentException($"seeds must be between 1 and {MaxSeeds}");
        }

        var duration = durationSeconds ?? scenario.DurationSeconds;
        if (duration is <= 0 or > MaxDurationSeconds)
        {
            throw new ArgumentException($"duration must be within (0, {MaxDurationSeconds}] seconds");
        }

        var warmup = Math.Clamp(warmupSeconds ?? 300, 0, 3600);
        var seeds = Enumerable.Range(0, seedCount).Select(i => scenario.Seed + i).ToList();
        var now = time.GetUtcNow();
        var job = new BatchJob(Guid.NewGuid(), scenarioId, seeds, duration, warmup, BatchStatus.Queued, [], null, null, now, now);
        jobs.Save(job);
        await queue.EnqueueAsync(job.Id, cancellationToken).ConfigureAwait(false);
        return job;
    }

    public BatchJob? Get(Guid id) => jobs.Get(id);

    public async Task RunAsync(Guid jobId, CancellationToken cancellationToken)
    {
        var job = jobs.Get(jobId);
        if (job is null || job.Status != BatchStatus.Queued)
        {
            return;
        }

        job = job with { Status = BatchStatus.Running, UpdatedAt = time.GetUtcNow() };
        jobs.Save(job);
        try
        {
            var scenario = await scenarios.GetAsync(job.ScenarioId, cancellationToken).ConfigureAwait(false);
            var compiled = await scenarios.CompileAsync(scenario.BaselineId, scenario.Changeset, cancellationToken).ConfigureAwait(false);
            var packageJson = JsonSerializer.Serialize(NetworkPackageWriter.DeserializeGzip(compiled.GzipPackage), NetworkPackage.JsonOptions);
            var result = await runner.RunAsync(packageJson, scenario.DemandJson ?? "{}", job.Seeds, job.DurationSeconds, job.WarmupSeconds, cancellationToken).ConfigureAwait(false);

            var root = JsonNode.Parse(result.ResultJson) ?? throw new InvalidOperationException("empty batch result");
            var runIds = new List<Guid>();
            foreach (var run in root["runs"]?.AsArray() ?? [])
            {
                var seed = run?["seed"]?.GetValue<long>() ?? 0;
                var summary = run?["summary"]?.ToJsonString() ?? "{}";
                var cells = result.CellsBySeed.GetValueOrDefault(seed) ?? [];
                var saved = await scenarios.AddRunAsync(job.ScenarioId, seed, job.DurationSeconds, summary, "lane-cells-v1", cells, cancellationToken).ConfigureAwait(false);
                runIds.Add(saved.Id);
            }

            job = job with { Status = BatchStatus.Completed, RunIds = runIds, Mean = root["network"]?.ToJsonString(), UpdatedAt = time.GetUtcNow() };
            jobs.Save(job);
            LogCompleted(job.Id, runIds.Count);
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException or NotFoundException or JsonException or BatchRunnerUnavailableException or IOException)
        {
            LogFailed(job.Id, ex.Message);
            jobs.Save(job with { Status = BatchStatus.Failed, Error = ex.Message, UpdatedAt = time.GetUtcNow() });
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Batch {JobId} stored {Runs} runs")]
    private partial void LogCompleted(Guid jobId, int runs);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Batch {JobId} failed: {Reason}")]
    private partial void LogFailed(Guid jobId, string reason);
}
