using Microsoft.EntityFrameworkCore;

namespace TrafficSim.Infrastructure.Persistence;

/// <summary>EF Core context for TrafficSim's PostGIS database (ADR-0003). Schema changes go through migrations.</summary>
public sealed class TrafficSimDbContext(DbContextOptions<TrafficSimDbContext> options) : DbContext(options)
{
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        modelBuilder.HasPostgresExtension("postgis");
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(TrafficSimDbContext).Assembly);
    }
}
