using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using TrafficSim.Application.Networks;

namespace TrafficSim.Infrastructure.Imports;

/// <summary>Runs queued network imports one at a time (community sources are rate limited anyway).</summary>
public sealed class ImportWorker(IImportQueue queue, IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var jobId in queue.DequeueAllAsync(stoppingToken).ConfigureAwait(false))
        {
            await using var scope = scopes.CreateAsyncScope();
            var service = scope.ServiceProvider.GetRequiredService<NetworkImportService>();
            await service.RunAsync(jobId, stoppingToken).ConfigureAwait(false);
        }
    }
}
