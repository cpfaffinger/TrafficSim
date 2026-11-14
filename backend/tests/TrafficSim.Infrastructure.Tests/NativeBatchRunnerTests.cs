using Microsoft.Extensions.Options;
using TrafficSim.Infrastructure.Batches;

namespace TrafficSim.Infrastructure.Tests;

public class NativeBatchRunnerTests
{
    [Fact]
    public void Builds_runner_arguments_and_reads_output()
    {
        var dir = Path.Combine(Path.GetTempPath(), "batch-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, "cells"));
        try
        {
            var args = NativeBatchRunner.Arguments(dir, [3, 4], 600, 60, 0);
            Assert.Equal("--seeds", args[4]);
            Assert.Equal("3,4", args[5]);
            Assert.Equal("600", args[7]);
            Assert.Equal("1", args[^1]);

            File.WriteAllText(Path.Combine(dir, "results.json"), "{\"runs\":[]}");
            File.WriteAllBytes(Path.Combine(dir, "cells", "cells-seed-3.bin"), [7]);
            var output = NativeBatchRunner.ReadOutput(dir, [3, 4]);
            Assert.Equal("{\"runs\":[]}", output.ResultJson);
            Assert.Equal([7], output.CellsBySeed[3]);
            Assert.False(output.CellsBySeed.ContainsKey(4));

            Assert.False(new NativeBatchRunner(Options.Create(new BatchRunnerOptions { Executable = Path.Combine(dir, "missing") })).IsAvailable);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
