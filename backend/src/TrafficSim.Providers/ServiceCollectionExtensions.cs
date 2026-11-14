using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TrafficSim.Application.Providers;
using TrafficSim.Providers.Http;
using TrafficSim.Providers.Photon;

namespace TrafficSim.Providers;

public static class ServiceCollectionExtensions
{
    /// <summary>Registers all enabled provider adapters (the provider registry, ADR-0004).</summary>
    public static IServiceCollection AddTrafficSimProviders(this IServiceCollection services, IConfiguration configuration)
    {
        var section = configuration.GetSection(ProvidersOptions.SectionName);
        services.Configure<ProvidersOptions>(section);
        var options = section.Get<ProvidersOptions>() ?? new ProvidersOptions();

        if (options.Photon.Enabled)
        {
            services.AddProviderHttpClient<IGeocodingProvider, PhotonGeocodingProvider>(
                PhotonGeocodingProvider.ProviderName, options.Photon, options.Contact);
        }

        return services;
    }
}
