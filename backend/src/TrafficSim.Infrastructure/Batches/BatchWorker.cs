using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using TrafficSim.Application.Batches;

namespace TrafficSim.Infrastructure.Batches;

/// <summary>Runs queued batch jobs one at a time (they use several threads each).</summary>
public sealed class BatchWorker(BatchQueue queue, IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var id in queue.DequeueAllAsync(stoppingToken).ConfigureAwait(false))
        {
            await using var scope = scopes.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<BatchService>().RunAsync(id, stoppingToken).ConfigureAwait(false);
        }
    }
}
