using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Networks;
using TrafficSim.Application.RoadSources;
using TrafficSim.Application.Scenarios;

namespace TrafficSim.Application;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddTrafficSimApplication(this IServiceCollection services)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.AddScoped<GeocodingService>();
        services.AddScoped<ReverseGeocodingService>();
        services.AddScoped<RoadNetworkService>();
        services.AddScoped<NetworkImportService>();
        services.AddScoped<ScenarioService>();
        services.TryAddSingleton<IImportJobStore, InMemoryImportJobStore>();
        services.TryAddSingleton<IImportQueue, ChannelImportQueue>();
        return services;
    }
}
