using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;
using TrafficSim.Infrastructure.Persistence;

[assembly: AssemblyFixture(typeof(TrafficSim.Infrastructure.Tests.PostGisFixture))]

namespace TrafficSim.Infrastructure.Tests;

/// <summary>
/// One PostGIS container per test run (Testcontainers, ADR-0013). When Docker is not available the
/// database tests are skipped locally; CI runners always have Docker.
/// </summary>
public sealed class PostGisFixture : IAsyncLifetime
{
    public const string Image = "postgis/postgis:17-3.5";

    private PostgreSqlContainer? _container;

    public string? ConnectionString { get; private set; }

    public string? UnavailableReason { get; private set; }

    public async ValueTask InitializeAsync()
    {
        try
        {
            _container = new PostgreSqlBuilder(Image).Build();
            await _container.StartAsync().ConfigureAwait(false);
            ConnectionString = _container.GetConnectionString();

            // Migrate once here: test classes run in parallel against the same database.
            await using var context = CreateContext();
            await context.Database.MigrateAsync().ConfigureAwait(false);
        }
        catch (Exception ex) when (Environment.GetEnvironmentVariable("CI") is null)
        {
            UnavailableReason = $"Docker not available: {ex.GetType().Name}";
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_container is not null)
        {
            await _container.DisposeAsync().ConfigureAwait(false);
        }
    }

    public string RequireDatabase()
    {
        if (ConnectionString is null)
        {
            Assert.Skip(UnavailableReason ?? "database not available");
        }

        return ConnectionString;
    }

    public TrafficSimDbContext CreateContext()
    {
        var options = new DbContextOptionsBuilder<TrafficSimDbContext>();
        PersistenceRegistration.Configure(options, RequireDatabase());
        return new TrafficSimDbContext(options.Options);
    }
}
