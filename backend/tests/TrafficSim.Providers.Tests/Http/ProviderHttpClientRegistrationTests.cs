using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TrafficSim.Application.Providers;
using TrafficSim.Providers.Http;
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
    public void Photon_is_registered_by_default_with_configured_base_address()
    {
        using var provider = BuildServices(new Dictionary<string, string?>
        {
            ["Providers:Photon:BaseUrl"] = "https://photon.internal/",
            ["Providers:Contact"] = "ops@example.org",
        });

        var geocoder = Assert.Single(provider.GetServices<IGeocodingProvider>());
        Assert.IsType<PhotonGeocodingProvider>(geocoder);

        var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient(PhotonGeocodingProvider.ProviderName);
        Assert.Equal(new Uri("https://photon.internal/"), client.BaseAddress);
        Assert.Contains("ops@example.org", client.DefaultRequestHeaders.UserAgent.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Disabled_provider_is_not_registered()
    {
        using var provider = BuildServices(new Dictionary<string, string?> { ["Providers:Photon:Enabled"] = "false" });

        Assert.Empty(provider.GetServices<IGeocodingProvider>());
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
