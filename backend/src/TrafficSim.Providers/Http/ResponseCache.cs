using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TrafficSim.Providers.Http;

/// <summary>A cached provider response body.</summary>
public sealed record CachedResponse(byte[] Body, string? ContentType);

/// <summary>Persistent cache for provider responses (ADR-0004, C-12: respect usage policies).</summary>
public interface IResponseCache
{
    Task<CachedResponse?> GetAsync(string key, CancellationToken cancellationToken);

    Task SetAsync(string key, CachedResponse response, TimeSpan ttl, CancellationToken cancellationToken);
}

/// <summary>
/// File-system response cache under a bind-mounted directory (ADR-0012). Each entry is a body file
/// plus a small JSON metadata file with the expiry; writes are atomic (temp file + rename).
/// </summary>
public sealed class FileResponseCache : IResponseCache
{
    private readonly string _directory;
    private readonly TimeProvider _time;

    public FileResponseCache(string directory, TimeProvider time)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        _directory = directory;
        _time = time;
    }

    public static string Key(string provider, Uri uri)
    {
        ArgumentNullException.ThrowIfNull(uri);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(uri.AbsoluteUri));
        return $"{provider}/{Convert.ToHexStringLower(hash)}";
    }

    public async Task<CachedResponse?> GetAsync(string key, CancellationToken cancellationToken)
    {
        var (meta, body) = Paths(key);
        if (!File.Exists(meta) || !File.Exists(body))
        {
            return null;
        }

        try
        {
            await using var stream = File.OpenRead(meta);
            var entry = await JsonSerializer.DeserializeAsync<Entry>(stream, cancellationToken: cancellationToken).ConfigureAwait(false);
            if (entry is null || entry.ExpiresAt <= _time.GetUtcNow())
            {
                return null;
            }

            var bytes = await File.ReadAllBytesAsync(body, cancellationToken).ConfigureAwait(false);
            return new CachedResponse(bytes, entry.ContentType);
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            return null; // a broken entry is a miss
        }
    }

    public async Task SetAsync(string key, CachedResponse response, TimeSpan ttl, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(response);
        var (meta, body) = Paths(key);
        Directory.CreateDirectory(Path.GetDirectoryName(meta)!);
        await WriteAtomicAsync(body, response.Body, cancellationToken).ConfigureAwait(false);
        var entry = new Entry(_time.GetUtcNow() + ttl, response.ContentType);
        await WriteAtomicAsync(meta, JsonSerializer.SerializeToUtf8Bytes(entry), cancellationToken).ConfigureAwait(false);
    }

    private (string Meta, string Body) Paths(string key)
    {
        var safe = string.Join(Path.DirectorySeparatorChar, key.Split('/').Select(SanitizeSegment));
        var basePath = Path.Combine(_directory, safe);
        return (basePath + ".json", basePath + ".body");
    }

    private static string SanitizeSegment(string segment) =>
        new(segment.Select(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());

    private static async Task WriteAtomicAsync(string path, byte[] content, CancellationToken cancellationToken)
    {
        var temp = $"{path}.{Guid.NewGuid():N}.tmp";
        await File.WriteAllBytesAsync(temp, content, cancellationToken).ConfigureAwait(false);
        File.Move(temp, path, overwrite: true);
    }

    private sealed record Entry(DateTimeOffset ExpiresAt, string? ContentType);
}
