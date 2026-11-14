using System.Net.Http.Headers;
using System.Reflection;
using System.Threading.RateLimiting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Logging;

namespace TrafficSim.Providers.Http;

/// <summary>
/// The shared fetch pipeline (ADR-0004). Every provider gets a typed HttpClient with an identifying
/// User-Agent and this handler chain (outermost first):
/// persistent response cache → telemetry (metrics + logs) → standard resilience (retry, circuit breaker,
/// timeouts) → client-side rate limiter (applies to every attempt).
/// </summary>
public static class ProviderHttpClientRegistration
{
    public static IHttpClientBuilder AddProviderHttpClient<TImplementation>(
        this IServiceCollection services,
        string providerName,
        HttpProviderOptions options,
        string contact)
        where TImplementation : class
    {
        ArgumentNullException.ThrowIfNull(options);

        var builder = services.AddHttpClient<TImplementation>(providerName, client =>
        {
            client.BaseAddress = options.BaseUrl;
            client.DefaultRequestHeaders.UserAgent.ParseAdd(BuildUserAgent(contact));
            client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            client.Timeout = Timeout.InfiniteTimeSpan; // timeouts are owned by the resilience pipeline
        });

        if (options.CacheTtl > TimeSpan.Zero)
        {
            builder.AddHttpMessageHandler(sp =>
                sp.GetService<IResponseCache>() is { } cache
                    ? new ResponseCacheHandler(providerName, options.CacheTtl, cache)
                    : new PassThroughHandler());
        }

        builder.AddHttpMessageHandler(sp => new ProviderTelemetryHandler(
            providerName,
            sp.GetRequiredService<ProviderMetrics>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger<ProviderTelemetryHandler>()));

        builder.AddStandardResilienceHandler(resilience =>
        {
            resilience.TotalRequestTimeout.Timeout = options.Timeout;
            resilience.AttemptTimeout.Timeout = TimeSpan.FromTicks(Math.Max(options.Timeout.Ticks / 2, TimeSpan.FromSeconds(1).Ticks));
            resilience.CircuitBreaker.SamplingDuration = TimeSpan.FromTicks(Math.Max(resilience.AttemptTimeout.Timeout.Ticks * 2, TimeSpan.FromSeconds(30).Ticks));
            resilience.Retry.MaxRetryAttempts = 2;
        });

        if (options.RequestsPerSecond is { } rps and > 0)
        {
            var limiter = CreateRateLimiter(rps);
            builder.AddHttpMessageHandler(() => new RateLimitingHandler(limiter));
        }

        return builder;
    }

    /// <summary>Token bucket that admits <paramref name="requestsPerSecond"/> on average and queues the rest.</summary>
    public static RateLimiter CreateRateLimiter(double requestsPerSecond)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(requestsPerSecond);
        return new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
        {
            TokenLimit = 1,
            TokensPerPeriod = 1,
            ReplenishmentPeriod = TimeSpan.FromSeconds(1 / requestsPerSecond),
            QueueLimit = 1000,
            QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            AutoReplenishment = true,
        });
    }

    public static string BuildUserAgent(string contact)
    {
        var version = typeof(ProviderHttpClientRegistration).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Split('+')[0] ?? "0.0.0";
        var sanitizedContact = string.IsNullOrWhiteSpace(contact) ? "https://github.com/cpfaffinger/TrafficSim" : contact.Trim();
        return $"TrafficSim/{version} (+{sanitizedContact})";
    }

    private sealed class PassThroughHandler : DelegatingHandler;
}
