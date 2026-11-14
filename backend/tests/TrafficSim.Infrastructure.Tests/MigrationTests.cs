using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using TrafficSim.Infrastructure.Health;
using TrafficSim.Infrastructure.Persistence;

namespace TrafficSim.Infrastructure.Tests;

public class MigrationTests(PostGisFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Migrator_applies_all_migrations_and_postgis_is_available()
    {
        var connectionString = db.RequireDatabase();
        var services = new ServiceCollection();
        services.AddDbContext<TrafficSimDbContext>(o => PersistenceRegistration.Configure(o, connectionString));
        await using var provider = services.BuildServiceProvider();

        var migrator = new DatabaseMigrator(provider.GetRequiredService<IServiceScopeFactory>(), NullLogger<DatabaseMigrator>.Instance);
        await migrator.StartAsync(Ct);
        await migrator.StartAsync(Ct); // idempotent
        await migrator.StopAsync(Ct);

        await using var context = db.CreateContext();
        Assert.Empty(await context.Database.GetPendingMigrationsAsync(Ct));

        await using var dataSource = NpgsqlDataSource.Create(connectionString);
        var health = await new PostGisHealthCheck(dataSource).CheckHealthAsync(new(), Ct);
        Assert.Equal(Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus.Healthy, health.Status);
    }

    [Fact]
    public async Task Health_check_reports_unreachable_database_as_unhealthy()
    {
        await using var dataSource = NpgsqlDataSource.Create("Host=127.0.0.1;Port=1;Timeout=1;Database=x;Username=x;Password=x");

        var health = await new PostGisHealthCheck(dataSource).CheckHealthAsync(new(), Ct);

        Assert.Equal(Microsoft.Extensions.Diagnostics.HealthChecks.HealthStatus.Unhealthy, health.Status);
    }
}
