using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TrafficSim.Application.Providers;
using TrafficSim.Providers.Geofabrik;
using TrafficSim.Providers.Google;
using TrafficSim.Providers.Http;
using TrafficSim.Providers.Nominatim;
using TrafficSim.Providers.Overpass;
using TrafficSim.Providers.Photon;
using TrafficSim.Providers.TerrainTiles;

namespace TrafficSim.Providers;

public static class ServiceCollectionExtensions
{
    /// <summary>Registers the provider registry and all enabled provider adapters (ADR-0004).</summary>
    public static IServiceCollection AddTrafficSimProviders(this IServiceCollection services, IConfiguration configuration)
    {
        var section = configuration.GetSection(ProvidersOptions.SectionName);
        services.Configure<ProvidersOptions>(section);
        var options = section.Get<ProvidersOptions>() ?? new ProvidersOptions();

        services.AddMetrics();
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<ProviderMetrics>();
        services.TryAddSingleton<IProviderCatalog, ProviderCatalog>();
        if (!string.IsNullOrWhiteSpace(options.Cache.Directory))
        {
            var directory = options.Cache.Directory;
            services.TryAddSingleton<IResponseCache>(sp => new FileResponseCache(directory, sp.GetRequiredService<TimeProvider>()));
        }

        if (options.Photon.Enabled)
        {
            services.AddProviderHttpClient<PhotonGeocodingProvider>(PhotonGeocodingProvider.ProviderName, options.Photon, options.Contact);
            services.AddTransient<IGeocodingProvider>(sp => sp.GetRequiredService<PhotonGeocodingProvider>());
            if (options.Photon.Reverse)
            {
                services.AddTransient<IReverseGeocodingProvider>(sp => sp.GetRequiredService<PhotonGeocodingProvider>());
            }
        }

        if (options.Nominatim.Enabled)
        {
            services.AddProviderHttpClient<NominatimProvider>(NominatimProvider.ProviderName, options.Nominatim, options.Contact);
            services.AddTransient<IReverseGeocodingProvider>(sp => sp.GetRequiredService<NominatimProvider>());
            services.AddTransient<IGeocodingProvider>(sp => sp.GetRequiredService<NominatimProvider>());
        }

        if (GoogleGeocodingProvider.IsUsable(options.Google))
        {
            services.AddProviderHttpClient<GoogleGeocodingProvider>(GoogleGeocodingProvider.ProviderName, options.Google, options.Contact);
            services.AddTransient<IGeocodingProvider>(sp => sp.GetRequiredService<GoogleGeocodingProvider>());
        }

        if (options.Overpass.Enabled)
        {
            services.AddProviderHttpClient<OverpassRoadNetworkSource>(OverpassRoadNetworkSource.ProviderName, options.Overpass, options.Contact);
            services.AddTransient<IRoadNetworkSource>(sp => sp.GetRequiredService<OverpassRoadNetworkSource>());
            services.AddProviderHttpClient<OverpassActivitySource>(OverpassActivitySource.ProviderName, options.Overpass, options.Contact);
            services.AddTransient<IActivitySource>(sp => sp.GetRequiredService<OverpassActivitySource>());
        }

        if (options.Geofabrik.Enabled && !string.IsNullOrWhiteSpace(options.Geofabrik.Directory))
        {
            services.AddProviderHttpClient<GeofabrikRoadNetworkSource>(GeofabrikRoadNetworkSource.ProviderName, options.Geofabrik, options.Contact);
            services.AddTransient<IRoadNetworkSource>(sp => sp.GetRequiredService<GeofabrikRoadNetworkSource>());
        }

        if (options.TerrainTiles.Enabled)
        {
            services.AddProviderHttpClient<TerrainTilesElevationProvider>(TerrainTilesElevationProvider.ProviderName, options.TerrainTiles, options.Contact);
            services.AddTransient<IElevationProvider>(sp => sp.GetRequiredService<TerrainTilesElevationProvider>());
        }

        return services;
    }
}
