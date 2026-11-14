using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TrafficSim.Application.Networks;
using TrafficSim.Domain.Editing;
using TrafficSim.Domain.Network.Compilation;

namespace TrafficSim.Application.Scenarios;

/// <summary>Raised when a referenced entity does not exist.</summary>
public sealed class NotFoundException : Exception
{
    public NotFoundException()
    {
    }

    public NotFoundException(string message)
        : base(message)
    {
    }

    public NotFoundException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

/// <summary>Raised when a changeset contains edits that cannot be applied.</summary>
public sealed class ChangesetValidationException(IReadOnlyList<EditIssue> issues)
    : Exception($"{issues?.Count ?? 0} edit(s) cannot be applied.")
{
    public IReadOnlyList<EditIssue> Issues { get; } = issues ?? [];
}

/// <summary>A compiled network for a baseline + changeset, with the edits that were skipped.</summary>
public sealed record CompiledNetwork(byte[] GzipPackage, IReadOnlyList<EditIssue> Issues);

/// <summary>Scenario management (#72), changeset compilation (#64/#70), share links (#76) and run results (#61).</summary>
public sealed class ScenarioService(INetworkBaselineStore baselines, IScenarioStore scenarios, IRunStore runs, TimeProvider time)
{
    public const int MaxChangesetOperations = 5000;
    public const int MaxBucketBytes = 32 * 1024 * 1024;
    private const int CacheCapacity = 32;

    // Compiled packages are pure functions of (baseline, changeset): cache the most recent ones.
    private static readonly ConcurrentDictionary<string, (byte[] Package, IReadOnlyList<EditIssue> Issues, long Tick)> Cache = new();
    private static long _tick;

    public static JsonSerializerOptions JsonOptions { get; } = new(JsonSerializerDefaults.Web);

    public async Task<Scenario> CreateAsync(string name, Guid baselineId, IReadOnlyList<EditOperation>? changeset, string? demandJson, long? seed, double? durationSeconds, CancellationToken cancellationToken)
    {
        await RequireBaselineAsync(baselineId, cancellationToken).ConfigureAwait(false);
        var ops = changeset ?? [];
        await ValidateChangesetAsync(baselineId, ops, cancellationToken).ConfigureAwait(false);
        var now = time.GetUtcNow();
        var scenario = new Scenario(Guid.NewGuid(), CleanName(name), baselineId, null, ops, ValidateJson(demandJson), seed ?? 1, Duration(durationSeconds), NewShareToken(), now, now);
        await scenarios.SaveAsync(scenario, cancellationToken).ConfigureAwait(false);
        return scenario;
    }

    public async Task<Scenario> UpdateAsync(Guid id, string? name, IReadOnlyList<EditOperation>? changeset, string? demandJson, long? seed, double? durationSeconds, CancellationToken cancellationToken)
    {
        var current = await GetAsync(id, cancellationToken).ConfigureAwait(false);
        if (changeset is not null)
        {
            await ValidateChangesetAsync(current.BaselineId, changeset, cancellationToken).ConfigureAwait(false);
        }

        var updated = current with
        {
            Name = name is null ? current.Name : CleanName(name),
            Changeset = changeset ?? current.Changeset,
            DemandJson = demandJson is null ? current.DemandJson : ValidateJson(demandJson),
            Seed = seed ?? current.Seed,
            DurationSeconds = durationSeconds is null ? current.DurationSeconds : Duration(durationSeconds),
            UpdatedAt = time.GetUtcNow(),
        };
        await scenarios.SaveAsync(updated, cancellationToken).ConfigureAwait(false);
        return updated;
    }

    /// <summary>Creates a variant of a scenario (same baseline, copied changeset and demand).</summary>
    public async Task<Scenario> CloneAsync(Guid id, string? name, CancellationToken cancellationToken)
    {
        var source = await GetAsync(id, cancellationToken).ConfigureAwait(false);
        var now = time.GetUtcNow();
        var clone = source with
        {
            Id = Guid.NewGuid(),
            ParentId = source.Id,
            Name = CleanName(name ?? $"{source.Name} (variant)"),
            ShareToken = NewShareToken(),
            CreatedAt = now,
            UpdatedAt = now,
        };
        await scenarios.SaveAsync(clone, cancellationToken).ConfigureAwait(false);
        return clone;
    }

    public async Task<Scenario> GetAsync(Guid id, CancellationToken cancellationToken) =>
        await scenarios.GetAsync(id, cancellationToken).ConfigureAwait(false) ?? throw new NotFoundException($"scenario {id} not found");

    public async Task<Scenario> GetSharedAsync(string token, CancellationToken cancellationToken) =>
        await scenarios.GetByShareTokenAsync(token, cancellationToken).ConfigureAwait(false) ?? throw new NotFoundException("share link not found");

    public Task<IReadOnlyList<Scenario>> ListAsync(Guid? baselineId, int limit, CancellationToken cancellationToken) =>
        scenarios.ListAsync(baselineId, Math.Clamp(limit, 1, 200), cancellationToken);

    public Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken) => scenarios.DeleteAsync(id, cancellationToken);

    /// <summary>Compiles a baseline with a changeset; skipped edits are reported (rebase / preview).</summary>
    public async Task<CompiledNetwork> CompileAsync(Guid baselineId, IReadOnlyList<EditOperation> changeset, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(changeset);
        if (changeset.Count == 0)
        {
            var package = await baselines.GetPackageAsync(baselineId, cancellationToken).ConfigureAwait(false)
                ?? throw new NotFoundException($"baseline {baselineId} not found");
            return new CompiledNetwork(package, []);
        }

        var key = CacheKey(baselineId, changeset);
        if (Cache.TryGetValue(key, out var hit))
        {
            Cache[key] = hit with { Tick = Interlocked.Increment(ref _tick) };
            return new CompiledNetwork(hit.Package, hit.Issues);
        }

        var info = await RequireBaselineAsync(baselineId, cancellationToken).ConfigureAwait(false);
        var osm = await baselines.GetOsmDataAsync(baselineId, cancellationToken).ConfigureAwait(false)
            ?? throw new NotFoundException($"baseline {baselineId} has no OSM data (imported before editing was available); import the area again");
        var result = ChangesetApplier.Apply(OsmDataCodec.Decode(osm), changeset);
        var terrain = await BaselineTerrainAsync(baselineId, cancellationToken).ConfigureAwait(false);
        var network = NetworkCompiler.Compile(result.Data, info.Shape, new CompilerOptions { Terrain = terrain }, result.Overrides);
        var bytes = NetworkPackageWriter.SerializeGzip(NetworkPackageWriter.ToPackage(network, baselineId, info.Attribution));

        Cache[key] = (bytes, result.Issues, Interlocked.Increment(ref _tick));
        foreach (var old in Cache.OrderByDescending(kv => kv.Value.Tick).Skip(CacheCapacity).Select(kv => kv.Key).ToList())
        {
            Cache.TryRemove(old, out _);
        }

        return new CompiledNetwork(bytes, result.Issues);
    }

    public async Task<SimulationRun> AddRunAsync(Guid scenarioId, long seed, double simulatedSeconds, string summaryJson, string bucketFormat, byte[] buckets, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(buckets);
        await GetAsync(scenarioId, cancellationToken).ConfigureAwait(false);
        if (buckets.Length > MaxBucketBytes)
        {
            throw new ArgumentException($"buckets exceed {MaxBucketBytes / (1024 * 1024)} MiB");
        }

        if (string.IsNullOrWhiteSpace(bucketFormat) || bucketFormat.Length > 64)
        {
            throw new ArgumentException("bucketFormat is required (max 64 characters)");
        }

        var run = new SimulationRun(Guid.NewGuid(), scenarioId, seed, Math.Max(0, simulatedSeconds), ValidateJson(summaryJson) ?? "{}", bucketFormat, time.GetUtcNow());
        await runs.SaveAsync(run, buckets, cancellationToken).ConfigureAwait(false);
        return run;
    }

    public Task<IReadOnlyList<SimulationRun>> ListRunsAsync(Guid scenarioId, CancellationToken cancellationToken) => runs.ListAsync(scenarioId, cancellationToken);

    public async Task<SimulationRun> GetRunAsync(Guid id, CancellationToken cancellationToken) =>
        await runs.GetAsync(id, cancellationToken).ConfigureAwait(false) ?? throw new NotFoundException($"run {id} not found");

    public async Task<byte[]> GetRunBucketsAsync(Guid id, CancellationToken cancellationToken) =>
        await runs.GetBucketsAsync(id, cancellationToken).ConfigureAwait(false) ?? throw new NotFoundException($"run {id} not found");

    /// <summary>Edits reuse the baseline's terrain (ADR-0018) instead of sampling it again; unreadable packages count as flat.</summary>
    private async Task<Domain.Network.TerrainGrid?> BaselineTerrainAsync(Guid baselineId, CancellationToken cancellationToken)
    {
        try
        {
            return await baselines.GetPackageAsync(baselineId, cancellationToken).ConfigureAwait(false) is { } stored
                ? NetworkPackageWriter.DeserializeGzip(stored).Terrain?.ToGrid()
                : null;
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            return null;
        }
    }

    internal static string CacheKey(Guid baselineId, IReadOnlyList<EditOperation> changeset)
    {
        var json = JsonSerializer.Serialize(changeset, JsonOptions);
        return $"{baselineId:N}:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(json)))}";
    }

    private async Task<NetworkBaselineInfo> RequireBaselineAsync(Guid baselineId, CancellationToken cancellationToken) =>
        await baselines.GetAsync(baselineId, cancellationToken).ConfigureAwait(false) ?? throw new NotFoundException($"baseline {baselineId} not found");

    private async Task ValidateChangesetAsync(Guid baselineId, IReadOnlyList<EditOperation> ops, CancellationToken cancellationToken)
    {
        if (ops.Count > MaxChangesetOperations)
        {
            throw new ArgumentException($"a changeset may contain at most {MaxChangesetOperations} edits");
        }

        if (ops.Count == 0)
        {
            return;
        }

        var compiled = await CompileAsync(baselineId, ops, cancellationToken).ConfigureAwait(false);
        if (compiled.Issues.Count > 0)
        {
            throw new ChangesetValidationException(compiled.Issues);
        }
    }

    private static string CleanName(string? name)
    {
        var trimmed = name?.Trim() ?? string.Empty;
        if (trimmed.Length is 0 or > 120)
        {
            throw new ArgumentException("name must be 1–120 characters");
        }

        return trimmed;
    }

    private static double Duration(double? seconds) =>
        seconds is null ? 3600 : seconds is > 0 and <= 86_400 ? seconds.Value : throw new ArgumentException("duration must be within (0, 86400] seconds");

    private static string? ValidateJson(string? json)
    {
        if (json is null)
        {
            return null;
        }

        if (json.Length > 1_000_000)
        {
            throw new ArgumentException("JSON document too large");
        }

        try
        {
            using var _ = JsonDocument.Parse(json);
            return json;
        }
        catch (JsonException ex)
        {
            throw new ArgumentException("invalid JSON", ex);
        }
    }

    internal static string NewShareToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(24)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
