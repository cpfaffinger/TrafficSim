using Microsoft.Extensions.DependencyInjection;
using TrafficSim.Application.Geocoding;

namespace TrafficSim.Application;

public static class ServiceCollectionExtensions
{
    public static IServiceCollection AddTrafficSimApplication(this IServiceCollection services)
    {
        services.AddScoped<GeocodingService>();
        return services;
    }
}
