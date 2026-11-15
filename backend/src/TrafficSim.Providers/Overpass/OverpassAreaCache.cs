using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Http;

namespace TrafficSim.Providers.Overpass;

/// <summary>
/// Raw Overpass road responses, unchanged as the API returned them, by the rectangle they cover (#138). A
/// request inside a cached rectangle reuses its response (the compiler clips the data to the import outline),
/// whichever instance answered. Bodies and a small index live in the provider response cache.
/// </summary>
internal sealed class OverpassAreaCache(IResponseCache cache, TimeProvider time, TimeSpan ttl)
{
    private const string IndexKey = "overpass-areas/index";

    /// <summary>The index is rewritten read-modify-write; one writer at a time per process.</summary>
    private static readonly SemaphoreSlim Gate = new(1, 1);

    /// <summary>Raw response of the smallest unexpired cached area containing <paramref name="area"/>, or null.</summary>
    public async Task<byte[]?> FindAsync(BoundingBox area, CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var candidates = (await ReadIndexAsync(cancellationToken).ConfigureAwait(false))
            .Where(e => e.ExpiresAt > now && e.Contains(area))
            .OrderBy(e => (e.North - e.South) * (e.East - e.West));
        foreach (var entry in candidates)
        {
            if (await cache.GetAsync(entry.Key, cancellationToken).ConfigureAwait(false) is { } hit)
            {
                return hit.Body;
            }
        }

        return null;
    }

    /// <summary>Stores the raw response for <paramref name="area"/>; failures to write never fail the import.</summary>
    public async Task StoreAsync(BoundingBox area, byte[] body, CancellationToken cancellationToken)
    {
        var id = string.Create(CultureInfo.InvariantCulture, $"{area.South:F7},{area.West:F7},{area.North:F7},{area.East:F7}");
        var key = "overpass-areas/" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(id)));
        try
        {
            await cache.SetAsync(key, new CachedResponse(body, "application/json"), ttl, cancellationToken).ConfigureAwait(false);
            await Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var now = time.GetUtcNow();
                var index = (await ReadIndexAsync(cancellationToken).ConfigureAwait(false))
                    .Where(e => e.ExpiresAt > now && e.Key != key)
                    .Append(new Entry(key, area.South, area.West, area.North, area.East, now + ttl))
                    .ToList();
                var json = JsonSerializer.SerializeToUtf8Bytes(index);
                // The index outlives every entry it lists; expired entries are dropped on the next write.
                await cache.SetAsync(IndexKey, new CachedResponse(json, "application/json"), ttl + TimeSpan.FromDays(1), cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                Gate.Release();
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // An unwritable cache must never break an import.
        }
    }

    private async Task<List<Entry>> ReadIndexAsync(CancellationToken cancellationToken)
    {
        if (await cache.GetAsync(IndexKey, cancellationToken).ConfigureAwait(false) is not { } hit)
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<List<Entry>>(hit.Body) ?? [];
        }
        catch (JsonException)
        {
            return []; // a broken index is empty
        }
    }

    private sealed record Entry(string Key, double South, double West, double North, double East, DateTimeOffset ExpiresAt)
    {
        private const double Epsilon = 1e-9;

        public bool Contains(BoundingBox area) =>
            South <= area.South + Epsilon && West <= area.West + Epsilon && North >= area.North - Epsilon && East >= area.East - Epsilon;
    }
}
