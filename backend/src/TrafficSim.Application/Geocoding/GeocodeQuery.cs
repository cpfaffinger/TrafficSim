using TrafficSim.Domain.Geo;

namespace TrafficSim.Application.Geocoding;

/// <summary>A validated forward-geocoding query.</summary>
public sealed record GeocodeQuery
{
    public const int MaxLimit = 20;
    public const int MaxTextLength = 200;

    public GeocodeQuery(string text, int limit = 5, string? language = null, GeoPoint? bias = null)
    {
        var trimmed = text?.Trim() ?? string.Empty;
        if (trimmed.Length == 0)
        {
            throw new ArgumentException("Query text must not be empty.", nameof(text));
        }

        if (trimmed.Length > MaxTextLength)
        {
            throw new ArgumentException($"Query text must not exceed {MaxTextLength} characters.", nameof(text));
        }

        if (limit is < 1 or > MaxLimit)
        {
            throw new ArgumentOutOfRangeException(nameof(limit), limit, $"Limit must be within [1, {MaxLimit}].");
        }

        Text = trimmed;
        Limit = limit;
        Language = string.IsNullOrWhiteSpace(language) ? null : language.Trim().ToLowerInvariant();
        Bias = bias;
    }

    public string Text { get; }

    public int Limit { get; }

    public string? Language { get; }

    public GeoPoint? Bias { get; }
}
