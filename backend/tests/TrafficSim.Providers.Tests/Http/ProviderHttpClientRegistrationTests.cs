using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TrafficSim.Application.Providers;
using TrafficSim.Providers.Geofabrik;
using TrafficSim.Providers.Google;
using TrafficSim.Providers.Http;
using TrafficSim.Providers.Nominatim;
using TrafficSim.Providers.Overpass;
using TrafficSim.Providers.Photon;

namespace TrafficSim.Providers.Tests.Http;

public class ProviderHttpClientRegistrationTests
{
    [Fact]
    public void User_agent_identifies_app_version_and_contact()
    {
        var ua = ProviderHttpClientRegistration.BuildUserAgent("ops@example.org");

        Assert.Matches(@"^TrafficSim/\d+\.\d+\.\d+ \(\+ops@example\.org\)$", ua);
    }

    [Fact]
    public void User_agent_falls_back_to_repository_url() =>
        Assert.EndsWith("(+https://github.com/cpfaffinger/TrafficSim)", ProviderHttpClientRegistration.BuildUserAgent(" "), StringComparison.Ordinal);

    [Fact]
    public void Free_providers_are_registered_by_default_with_configured_base_address()
    {
        using var provider = BuildServices(new Dictionary<string, string?>
        {
            ["Providers:Photon:BaseUrl"] = "https://photon.internal/",
            ["Providers:Contact"] = "ops@example.org",
        });

        var geocoders = provider.GetServices<IGeocodingProvider>().ToList();
        Assert.Contains(geocoders, g => g is PhotonGeocodingProvider);
        Assert.Contains(geocoders, g => g is NominatimProvider);
        Assert.DoesNotContain(geocoders, g => g is GoogleGeocodingProvider);
        Assert.Equal(2, provider.GetServices<IReverseGeocodingProvider>().Count());
        Assert.IsType<OverpassRoadNetworkSource>(Assert.Single(provider.GetServices<IRoadNetworkSource>()));

        var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient(PhotonGeocodingProvider.ProviderName);
        Assert.Equal(new Uri("https://photon.internal/"), client.BaseAddress);
        Assert.Contains("ops@example.org", client.DefaultRequestHeaders.UserAgent.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Disabled_providers_are_not_registered()
    {
        using var provider = BuildServices(new Dictionary<string, string?>
        {
            ["Providers:Photon:Enabled"] = "false",
            ["Providers:Nominatim:Enabled"] = "false",
            ["Providers:Overpass:Enabled"] = "false",
        });

        Assert.Empty(provider.GetServices<IGeocodingProvider>());
        Assert.Empty(provider.GetServices<IReverseGeocodingProvider>());
        Assert.Empty(provider.GetServices<IRoadNetworkSource>());
    }

    [Fact]
    public void Photon_reverse_can_be_switched_off()
    {
        using var provider = BuildServices(new Dictionary<string, string?>
        {
            ["Providers:Photon:Reverse"] = "false",
            ["Providers:Nominatim:Enabled"] = "false",
        });

        Assert.Empty(provider.GetServices<IReverseGeocodingProvider>());
    }

    [Fact]
    public void Google_and_geofabrik_need_explicit_configuration()
    {
        using var provider = BuildServices(new Dictionary<string, string?>
        {
            ["Providers:Google:Enabled"] = "true",
            ["Providers:Google:ApiKey"] = "test-key",
            ["Providers:Geofabrik:Directory"] = Path.GetTempPath(),
        });

        Assert.Contains(provider.GetServices<IGeocodingProvider>(), g => g is GoogleGeocodingProvider);
        Assert.Contains(provider.GetServices<IRoadNetworkSource>(), s => s is GeofabrikRoadNetworkSource);
    }

    [Fact]
    public void Catalog_describes_all_known_providers()
    {
        using var provider = BuildServices(new Dictionary<string, string?> { ["Providers:Google:Enabled"] = "true" });

        var catalog = provider.GetRequiredService<IProviderCatalog>().Providers;

        Assert.Equal(["photon", "nominatim", "overpass", "geofabrik", "google", "openfreemap", "terrain-tiles"], catalog.Select(p => p.Name));
        Assert.False(catalog.Single(p => p.Name == "google").Enabled); // no API key
        Assert.False(catalog.Single(p => p.Name == "geofabrik").Enabled); // no directory
        Assert.Contains(ProviderCapability.ReverseGeocoding, catalog.Single(p => p.Name == "photon").Capabilities);
        Assert.Single(catalog, p => p.Commercial);
    }

    private static ServiceProvider BuildServices(Dictionary<string, string?> settings)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(settings).Build();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddTrafficSimProviders(configuration);
        return services.BuildServiceProvider();
    }
}
