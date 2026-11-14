using System.Net.Http.Headers;
using System.Reflection;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;

namespace TrafficSim.Providers.Http;

/// <summary>
/// The shared fetch pipeline (ADR-0004): every provider gets a typed HttpClient with an
/// identifying User-Agent, a base address and the standard resilience handler
/// (rate limiter, total timeout, retry with jitter, circuit breaker, attempt timeout).
/// </summary>
public static class ProviderHttpClientRegistration
{
    public static IHttpClientBuilder AddProviderHttpClient<TClient, TImplementation>(
        this IServiceCollection services,
        string providerName,
        HttpProviderOptions options,
        string contact)
        where TClient : class
        where TImplementation : class, TClient
    {
        ArgumentNullException.ThrowIfNull(options);

        var builder = services.AddHttpClient<TClient, TImplementation>(providerName, client =>
        {
            client.BaseAddress = options.BaseUrl;
            client.DefaultRequestHeaders.UserAgent.ParseAdd(BuildUserAgent(contact));
            client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            client.Timeout = Timeout.InfiniteTimeSpan; // timeouts are owned by the resilience pipeline
        });

        builder.AddStandardResilienceHandler(resilience =>
        {
            resilience.TotalRequestTimeout.Timeout = options.Timeout;
            resilience.AttemptTimeout.Timeout = TimeSpan.FromTicks(Math.Max(options.Timeout.Ticks / 2, TimeSpan.FromSeconds(1).Ticks));
            resilience.CircuitBreaker.SamplingDuration = TimeSpan.FromTicks(Math.Max(resilience.AttemptTimeout.Timeout.Ticks * 2, TimeSpan.FromSeconds(30).Ticks));
            resilience.Retry.MaxRetryAttempts = 2;
        });

        return builder;
    }

    public static string BuildUserAgent(string contact)
    {
        var version = typeof(ProviderHttpClientRegistration).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Split('+')[0] ?? "0.0.0";
        var sanitizedContact = string.IsNullOrWhiteSpace(contact) ? "https://github.com/cpfaffinger/TrafficSim" : contact.Trim();
        return $"TrafficSim/{version} (+{sanitizedContact})";
    }
}
