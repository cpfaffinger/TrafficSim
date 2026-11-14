using Microsoft.Extensions.Options;

namespace TrafficSim.Providers.Tests.Support;

internal static class ProviderFactory
{
    public static IOptions<ProvidersOptions> Options(Action<ProvidersOptions>? configure = null)
    {
        var options = new ProvidersOptions();
        configure?.Invoke(options);
        return Microsoft.Extensions.Options.Options.Create(options);
    }

    public static HttpClient Client(HttpMessageHandler handler, string baseUrl) => new(handler) { BaseAddress = new Uri(baseUrl) };
}
