using Microsoft.Extensions.Diagnostics.HealthChecks;
using Npgsql;

namespace TrafficSim.Infrastructure.Health;

/// <summary>Readiness check: database reachable and PostGIS extension available.</summary>
public sealed class PostGisHealthCheck(NpgsqlDataSource dataSource) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        try
        {
            await using var command = dataSource.CreateCommand("SELECT postgis_lib_version()");
            var version = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) as string;
            return HealthCheckResult.Healthy("PostGIS available", new Dictionary<string, object>
            {
                ["postgis"] = version ?? "unknown",
            });
        }
        catch (Exception ex) when (ex is NpgsqlException or InvalidOperationException or TimeoutException)
        {
            return HealthCheckResult.Unhealthy("Database or PostGIS not available", ex);
        }
    }
}
