namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Driving direction relative to the OSM way's node order.</summary>
public enum TravelDirection
{
    Forward,
    Backward,
}

/// <summary>Which directions a way can be driven in.</summary>
public enum OneWay
{
    No,
    Forward,
    Backward,
}

/// <summary>Helpers for reading OSM tags.</summary>
public static class Tags
{
    public static string? Get(IReadOnlyDictionary<string, string> tags, string key)
    {
        ArgumentNullException.ThrowIfNull(tags);
        return tags.TryGetValue(key, out var v) && !string.IsNullOrWhiteSpace(v) ? v.Trim() : null;
    }

    /// <summary>Directional variant first (<c>key:forward</c>), then the plain key.</summary>
    public static string? GetDirectional(IReadOnlyDictionary<string, string> tags, string key, TravelDirection direction) =>
        Get(tags, $"{key}:{Suffix(direction)}") ?? Get(tags, key);

    public static string Suffix(TravelDirection direction) => direction == TravelDirection.Forward ? "forward" : "backward";

    public static int? GetInt(IReadOnlyDictionary<string, string> tags, string key) =>
        int.TryParse(Get(tags, key), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;

    public static bool IsYes(string? value) => value is "yes" or "true" or "1" or "designated";

    public static bool IsNo(string? value) => value is "no" or "false" or "0";

    /// <summary>
    /// Reads a <c>*:lanes</c> tag for one direction and returns values indexed by lane (0 = rightmost),
    /// or null when absent or when its lane count does not match <paramref name="laneCount"/>.
    /// </summary>
    public static IReadOnlyList<string>? GetLanes(
        IReadOnlyDictionary<string, string> tags, string key, TravelDirection direction, OneWay oneWay, int laneCount)
    {
        var raw = Get(tags, $"{key}:lanes:{Suffix(direction)}");
        if (raw is null && oneWay != OneWay.No)
        {
            raw = Get(tags, $"{key}:lanes");
        }

        if (raw is null)
        {
            return null;
        }

        var values = SplitLanes(raw);
        if (values.Count != laneCount)
        {
            return null;
        }

        return values.Reverse().ToList(); // OSM lists lanes left to right; index 0 is the rightmost lane
    }

    public static IReadOnlyList<string> SplitLanes(string raw) =>
        (raw ?? string.Empty).Split('|').Select(v => v.Trim()).ToList();
}
