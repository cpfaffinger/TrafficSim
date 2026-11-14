namespace TrafficSim.Application.Providers;

/// <summary>A provider's answer together with the provider that produced it.</summary>
public sealed record ProviderAnswer<T>(T Value, string Provider, string Attribution);

/// <summary>
/// Tries providers by ascending priority and falls back to the next one when a provider is unavailable
/// (ADR-0004). A valid but empty answer does not trigger a fallback.
/// </summary>
public static class ProviderFallback
{
    public static async Task<ProviderAnswer<TResult>> FirstAvailableAsync<TProvider, TResult>(
        IEnumerable<TProvider> providers,
        string capability,
        Func<TProvider, Task<TResult>> call,
        Action<TProvider, ProviderUnavailableException>? onFailure = null)
        where TProvider : IProvider
    {
        ArgumentNullException.ThrowIfNull(providers);
        ArgumentNullException.ThrowIfNull(call);
        var ordered = Order(providers);
        var failures = new List<Exception>();

        foreach (var provider in ordered)
        {
            try
            {
                var result = await call(provider).ConfigureAwait(false);
                return new ProviderAnswer<TResult>(result, provider.Name, provider.Attribution);
            }
            catch (ProviderUnavailableException ex)
            {
                onFailure?.Invoke(provider, ex);
                failures.Add(ex);
            }
        }

        throw new NoProviderAvailableException(
            ordered.Count == 0 ? $"No {capability} provider is configured." : $"All {capability} providers failed.",
            new AggregateException(failures));
    }

    public static IReadOnlyList<TProvider> Order<TProvider>(IEnumerable<TProvider> providers)
        where TProvider : IProvider =>
        providers.OrderBy(p => p.Priority).ThenBy(p => p.Name, StringComparer.Ordinal).ToList();
}
