using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using TrafficSim.Infrastructure.Health;

namespace TrafficSim.Infrastructure;

public static class ServiceCollectionExtensions
{
    public const string ConnectionStringName = "TrafficSim";
    public const string ReadyTag = "ready";

    public static IServiceCollection AddTrafficSimInfrastructure(this IServiceCollection services, IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString(ConnectionStringName);
        var healthChecks = services.AddHealthChecks();

        if (!string.IsNullOrWhiteSpace(connectionString))
        {
            services.AddSingleton(_ => NpgsqlDataSource.Create(connectionString));
            healthChecks.AddCheck<PostGisHealthCheck>("postgis", tags: [ReadyTag]);
        }

        return services;
    }
}
