using System.Text.Json;
using TrafficSim.Application.Providers;

namespace TrafficSim.Providers.Http;

/// <summary>Translates transport-level failures into <see cref="ProviderUnavailableException"/> (one place for all ACLs).</summary>
internal static class ProviderErrors
{
    public static async Task<T> GuardAsync<T>(string provider, Func<Task<T>> call, CancellationToken cancellationToken)
    {
        try
        {
            return await call().ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            throw new ProviderUnavailableException(provider, ex.Message, ex);
        }
        catch (JsonException ex)
        {
            throw new ProviderUnavailableException(provider, "invalid response body", ex);
        }
        catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ProviderUnavailableException(provider, "timeout", ex);
        }
        catch (Polly.CircuitBreaker.BrokenCircuitException ex)
        {
            throw new ProviderUnavailableException(provider, "circuit open", ex);
        }
        catch (Polly.Timeout.TimeoutRejectedException ex)
        {
            throw new ProviderUnavailableException(provider, "timeout", ex);
        }
        catch (Polly.RateLimiting.RateLimiterRejectedException ex)
        {
            throw new ProviderUnavailableException(provider, "rate limited", ex);
        }
    }

    public static void EnsureSuccess(string provider, HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw new ProviderUnavailableException(provider, $"HTTP {(int)response.StatusCode}");
        }
    }
}
