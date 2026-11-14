using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace TrafficSim.Infrastructure.Persistence;

/// <summary>Applies pending migrations at startup before the app reports ready (C-03: one command to run).</summary>
public sealed partial class DatabaseMigrator(IServiceScopeFactory scopes, ILogger<DatabaseMigrator> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TrafficSimDbContext>();
        var pending = (await db.Database.GetPendingMigrationsAsync(cancellationToken).ConfigureAwait(false)).ToList();
        if (pending.Count > 0)
        {
            LogApplying(pending.Count, string.Join(", ", pending));
            await db.Database.MigrateAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    [LoggerMessage(Level = LogLevel.Information, Message = "Applying {Count} database migration(s): {Migrations}")]
    private partial void LogApplying(int count, string migrations);
}
