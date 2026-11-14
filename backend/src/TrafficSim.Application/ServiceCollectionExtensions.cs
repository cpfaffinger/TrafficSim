using Microsoft.Extensions.DependencyInjection;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.RoadNetwork;

namespace TrafficSim.Application;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddTrafficSimApplication(this IServiceCollection services)
    {
        services.AddScoped<GeocodingService>();
        services.AddScoped<ReverseGeocodingService>();
        services.AddScoped<RoadNetworkService>();
        return services;
    }
}
