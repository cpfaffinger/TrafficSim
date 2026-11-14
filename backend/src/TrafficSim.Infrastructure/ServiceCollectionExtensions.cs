using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using TrafficSim.Application.Networks;
using TrafficSim.Application.Scenarios;
using TrafficSim.Infrastructure.Health;
using TrafficSim.Infrastructure.Imports;
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
            services.AddScoped<INetworkBaselineStore, EfNetworkBaselineStore>();
            services.AddScoped<IScenarioStore, EfScenarioStore>();
            services.AddScoped<IRunStore, EfRunStore>();
            healthChecks.AddCheck<PostGisHealthCheck>("postgis", tags: [ReadyTag]);
        }
        else
        {
            // Development and tests without a database.
            services.TryAddSingleton<INetworkBaselineStore, InMemoryNetworkBaselineStore>();
            services.TryAddSingleton<IScenarioStore, InMemoryScenarioStore>();
            services.TryAddSingleton<IRunStore, InMemoryRunStore>();
        }

        services.AddHostedService<ImportWorker>();
        return services;
    }
}
