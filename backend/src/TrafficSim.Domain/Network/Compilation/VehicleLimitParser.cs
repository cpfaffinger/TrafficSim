using System.Globalization;
using System.Text.RegularExpressions;

namespace TrafficSim.Domain.Network.Compilation;

/// <summary>
/// Legal and physical vehicle dimension limits of a way (#125): <c>maxlength</c>, <c>maxwidth</c>,
/// <c>maxheight</c> and <c>maxweight</c>, their directional and <c>:physical</c> variants (the
/// stricter value wins). Lengths in metres (also feet/inches), weights in tonnes (also kg, lbs).
/// </summary>
public static partial class VehicleLimitParser
{
    public static VehicleLimits? ForWay(IReadOnlyDictionary<string, string> tags, TravelDirection direction)
    {
        double? Strictest(string key, Func<string?, double?> parse) =>
            new[] { Tags.GetDirectional(tags, key, direction), Tags.Get(tags, key + ":physical") }
                .Select(parse)
                .Where(v => v is not null)
                .Min();

        var limits = new VehicleLimits(
            Strictest("maxlength", ParseMetres),
            Strictest("maxwidth", ParseMetres),
            Strictest("maxheight", ParseMetres),
            Strictest("maxweight", ParseTonnes));
        return limits.IsEmpty ? null : limits;
    }

    /// <summary>Metres from <c>3.5</c>, <c>3.5 m</c>, <c>12'6"</c>, <c>12 ft</c>; null for none/default/unparsable.</summary>
    public static double? ParseMetres(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var v = value.Trim().Replace(',', '.');
        if (FeetInches().Match(v) is { Success: true } fi)
        {
            var feet = double.Parse(fi.Groups[1].Value, CultureInfo.InvariantCulture);
            var inches = fi.Groups[2].Success ? double.Parse(fi.Groups[2].Value, CultureInfo.InvariantCulture) : 0;
            return Positive((feet * 0.3048) + (inches * 0.0254));
        }

        if (NumberWithUnit().Match(v) is { Success: true } m)
        {
            var n = double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            return m.Groups[2].Value switch
            {
                "" or "m" => Positive(n),
                "ft" => Positive(n * 0.3048),
                "cm" => Positive(n / 100),
                _ => null,
            };
        }

        return null;
    }

    /// <summary>Tonnes from <c>7.5</c>, <c>7.5 t</c>, <c>7500 kg</c>, <c>20000 lbs</c>, <c>3 st</c>.</summary>
    public static double? ParseTonnes(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || NumberWithUnit().Match(value.Trim().Replace(',', '.')) is not { Success: true } m)
        {
            return null;
        }

        var n = double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        return m.Groups[2].Value switch
        {
            "" or "t" => Positive(n),
            "kg" => Positive(n / 1000),
            "lbs" => Positive(n * 0.000453592),
            "st" => Positive(n * 0.907185),
            _ => null,
        };
    }

    private static double? Positive(double v) => v > 0 && double.IsFinite(v) ? Math.Round(v, 2) : null;

    [GeneratedRegex(@"^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"")?$")]
    private static partial Regex FeetInches();

    [GeneratedRegex(@"^(\d+(?:\.\d+)?)\s*(m|ft|cm|t|kg|lbs|st)?$")]
    private static partial Regex NumberWithUnit();
}
