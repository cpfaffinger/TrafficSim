using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using Microsoft.Extensions.Options;
using TrafficSim.Application.Batches;

namespace TrafficSim.Infrastructure.Batches;

public sealed class BatchRunnerOptions
{
    public const string SectionName = "Batch";

    /// <summary>Path of the sim-core <c>batch</c> binary (installed in the Docker image).</summary>
    public string Executable { get; set; } = "/app/tools/trafficsim-batch";

    public int Threads { get; set; } = 2;

    public TimeSpan Timeout { get; set; } = TimeSpan.FromMinutes(30);
}

/// <summary>Runs the native sim-core batch binary as a child process (#84).</summary>
public sealed class NativeBatchRunner(IOptions<BatchRunnerOptions> options) : IBatchRunner
{
    private readonly BatchRunnerOptions _options = options.Value;

    public bool IsAvailable => File.Exists(_options.Executable);

    /// <summary>Command-line arguments for the runner (see sim-core/README.md "Batch runner").</summary>
    public static IReadOnlyList<string> Arguments(string dir, IReadOnlyList<long> seeds, double duration, double warmup, int threads) =>
    [
        "--package", Path.Combine(dir, "package.json"),
        "--config", Path.Combine(dir, "config.json"),
        "--seeds", string.Join(',', seeds.Select(s => s.ToString(CultureInfo.InvariantCulture))),
        "--duration", duration.ToString("R", CultureInfo.InvariantCulture),
        "--warmup", warmup.ToString("R", CultureInfo.InvariantCulture),
        "--out", Path.Combine(dir, "results.json"),
        "--cells-dir", Path.Combine(dir, "cells"),
        "--threads", Math.Max(1, threads).ToString(CultureInfo.InvariantCulture),
    ];

    /// <summary>Reads the runner output files.</summary>
    public static BatchRunnerResult ReadOutput(string dir, IReadOnlyList<long> seeds)
    {
        var result = File.ReadAllText(Path.Combine(dir, "results.json"));
        var cells = new Dictionary<long, byte[]>();
        foreach (var seed in seeds)
        {
            var file = Path.Combine(dir, "cells", $"cells-seed-{seed.ToString(CultureInfo.InvariantCulture)}.bin");
            if (File.Exists(file))
            {
                cells[seed] = File.ReadAllBytes(file);
            }
        }

        return new BatchRunnerResult(result, cells);
    }

    [ExcludeFromCodeCoverage(Justification = "Process glue; exercised in the deployed image.")]
    public async Task<BatchRunnerResult> RunAsync(string packageJson, string configJson, IReadOnlyList<long> seeds, double durationSeconds, double warmupSeconds, CancellationToken cancellationToken)
    {
        if (!IsAvailable)
        {
            throw new BatchRunnerUnavailableException();
        }

        var dir = Path.Combine(Path.GetTempPath(), "trafficsim-batch-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "cells"));
        try
        {
            await File.WriteAllTextAsync(Path.Combine(dir, "package.json"), packageJson, cancellationToken).ConfigureAwait(false);
            await File.WriteAllTextAsync(Path.Combine(dir, "config.json"), configJson, cancellationToken).ConfigureAwait(false);
            var start = new ProcessStartInfo(_options.Executable) { RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false };
            foreach (var arg in Arguments(dir, seeds, durationSeconds, warmupSeconds, _options.Threads))
            {
                start.ArgumentList.Add(arg);
            }

            using var process = Process.Start(start) ?? throw new InvalidOperationException("could not start the batch runner");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(_options.Timeout);
            var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
            _ = process.StandardOutput.ReadToEndAsync(timeout.Token);
            try
            {
                await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                process.Kill(entireProcessTree: true);
                throw new InvalidOperationException("the batch run timed out");
            }

            if (process.ExitCode != 0)
            {
                throw new InvalidOperationException($"batch runner failed: {(await stderr.ConfigureAwait(false)).Trim()}");
            }

            return ReadOutput(dir, seeds);
        }
        finally
        {
            try
            {
                Directory.Delete(dir, recursive: true);
            }
            catch (IOException)
            {
                // best effort
            }
        }
    }
}
