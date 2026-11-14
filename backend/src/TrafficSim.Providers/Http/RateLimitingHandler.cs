using System.Net;
using System.Threading.RateLimiting;

namespace TrafficSim.Providers.Http;

/// <summary>Waits for a rate-limit permit before each request; answers 429 when the queue is full.</summary>
internal sealed class RateLimitingHandler(RateLimiter limiter) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        using var lease = await limiter.AcquireAsync(1, cancellationToken).ConfigureAwait(false);
        if (!lease.IsAcquired)
        {
            return new HttpResponseMessage(HttpStatusCode.TooManyRequests) { RequestMessage = request };
        }

        return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
}
