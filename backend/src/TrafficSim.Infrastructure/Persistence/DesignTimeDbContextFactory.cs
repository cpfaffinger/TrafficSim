using System.Diagnostics.CodeAnalysis;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace TrafficSim.Infrastructure.Persistence;

/// <summary>Used by <c>dotnet ef migrations add</c> only; no database connection is opened.</summary>
[ExcludeFromCodeCoverage]
internal sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<TrafficSimDbContext>
{
    public TrafficSimDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<TrafficSimDbContext>();
        PersistenceRegistration.Configure(options, "Host=localhost;Database=trafficsim_design");
        return new TrafficSimDbContext(options.Options);
    }
}
