using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using TrafficSim.Infrastructure.Health;
using TrafficSim.Infrastructure.Persistence;

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
            services.AddDbContext<TrafficSimDbContext>(options => PersistenceRegistration.Configure(options, connectionString));
            services.AddHostedService<DatabaseMigrator>();
            healthChecks.AddCheck<PostGisHealthCheck>("postgis", tags: [ReadyTag]);
        }

        return services;
    }
}
