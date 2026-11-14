using System.Net;
using System.Net.Http.Headers;

namespace TrafficSim.Providers.Http;

/// <summary>Serves successful GET responses from the persistent cache and stores new ones.</summary>
internal sealed class ResponseCacheHandler(string provider, TimeSpan ttl, IResponseCache cache) : DelegatingHandler
{
    public const string CacheHeader = "X-TrafficSim-Cache";

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.Method != HttpMethod.Get || request.RequestUri is null)
        {
            return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }

        var key = FileResponseCache.Key(provider, request.RequestUri);
        if (await cache.GetAsync(key, cancellationToken).ConfigureAwait(false) is { } hit)
        {
            var cached = new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = Content(hit) };
            cached.Headers.Add(CacheHeader, "hit");
            return cached;
        }

        var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (response.StatusCode != HttpStatusCode.OK)
        {
            return response;
        }

        var body = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        var entry = new CachedResponse(body, response.Content.Headers.ContentType?.ToString());
        try
        {
            await cache.SetAsync(key, entry, ttl, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // An unwritable cache must never break a provider request.
        }

        var fresh = new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = request, Content = Content(entry) };
        fresh.Headers.Add(CacheHeader, "miss");
        response.Dispose();
        return fresh;
    }

    private static ByteArrayContent Content(CachedResponse entry)
    {
        var content = new ByteArrayContent(entry.Body);
        if (entry.ContentType is not null && MediaTypeHeaderValue.TryParse(entry.ContentType, out var type))
        {
            content.Headers.ContentType = type;
        }

        return content;
    }
}
