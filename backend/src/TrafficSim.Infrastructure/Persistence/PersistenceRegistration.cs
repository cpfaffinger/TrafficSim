using Microsoft.EntityFrameworkCore;

namespace TrafficSim.Infrastructure.Persistence;

/// <summary>Shared EF Core configuration (runtime, design time and tests).</summary>
public static class PersistenceRegistration
{
    public static void Configure(DbContextOptionsBuilder options, string connectionString)
    {
        ArgumentNullException.ThrowIfNull(options);
        options.UseNpgsql(connectionString, npgsql =>
        {
            npgsql.UseNetTopologySuite();
            npgsql.MigrationsHistoryTable("__ef_migrations_history");
        });
        options.UseSnakeCaseNamingConvention();
    }
}
