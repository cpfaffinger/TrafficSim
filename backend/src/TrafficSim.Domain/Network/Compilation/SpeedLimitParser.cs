using System.Globalization;
using System.Text.RegularExpressions;

namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Parses OSM <c>maxspeed</c> values into m/s (#25).</summary>
public static partial class SpeedLimitParser
{
    public const double KmhToMs = 1 / 3.6;
    private const double MphToKmh = 1.609344;
    private const double KnotsToKmh = 1.852;

    private static readonly Dictionary<string, (double Rural, double Motorway)> Countries = new(StringComparer.Ordinal)
    {
        ["DE"] = (100, 130),
        ["AT"] = (100, 130),
        ["CH"] = (80, 120),
        ["FR"] = (80, 130),
        ["IT"] = (90, 130),
        ["NL"] = (80, 100),
        ["BE"] = (70, 120),
        ["PL"] = (90, 140),
        ["CZ"] = (90, 130),
        ["ES"] = (90, 120),
        ["GB"] = (96.56, 112.65),
        ["US"] = (88.5, 104.6),
    };

    /// <summary>Returns km/h for a maxspeed value, or null when it cannot be interpreted.</summary>
    public static double? ParseKmh(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var v = value.Trim();
        switch (v)
        {
            case "walk":
                return 7;
            case "none":
            case "signals":
            case "variable":
                return v == "none" ? 130 : null;
        }

        var numeric = Numeric().Match(v);
        if (numeric.Success)
        {
            var number = double.Parse(numeric.Groups["n"].Value, CultureInfo.InvariantCulture);
            var unit = numeric.Groups["u"].Value.Trim();
            return unit switch
            {
                "" or "km/h" or "kmh" or "kph" => number,
                "mph" => number * MphToKmh,
                "knots" => number * KnotsToKmh,
                _ => null,
            };
        }

        var zone = Zone().Match(v);
        if (!zone.Success)
        {
            return null;
        }

        var (rural, motorway) = Countries.GetValueOrDefault(zone.Groups["c"].Value, (100, 120));
        var kind = zone.Groups["k"].Value;
        if (zone.Groups["z"].Success)
        {
            return double.Parse(zone.Groups["z"].Value, CultureInfo.InvariantCulture);
        }

        return kind switch
        {
            "urban" => 50,
            "rural" => rural,
            "motorway" => motorway,
            "trunk" => Math.Min(rural, 100),
            "living_street" or "pedestrian_zone" => 7,
            "bicycle_road" => 30,
            _ => null,
        };
    }

    /// <summary>Speed limit of a way in one direction in m/s, with an assumed flag when defaults were used.</summary>
    public static (double Ms, bool Assumed) ForWay(IReadOnlyDictionary<string, string> tags, RoadClass roadClass, TravelDirection direction)
    {
        var kmh = ParseKmh(Tags.GetDirectional(tags, "maxspeed", direction))
            ?? ParseKmh(Tags.Get(tags, "maxspeed:type"))
            ?? ParseKmh(Tags.Get(tags, "zone:maxspeed"))
            ?? ParseKmh(Tags.Get(tags, "source:maxspeed"));
        return kmh is { } k and > 0 ? (k * KmhToMs, false) : (RoadClasses.DefaultSpeedKmh(roadClass) * KmhToMs, true);
    }

    [GeneratedRegex(@"^(?<n>\d+(\.\d+)?)\s*(?<u>km/h|kmh|kph|mph|knots)?$", RegexOptions.CultureInvariant)]
    private static partial Regex Numeric();

    [GeneratedRegex(@"^(?<c>[A-Z]{2}):(?<k>urban|rural|motorway|trunk|living_street|pedestrian_zone|bicycle_road|zone:?(?<z>\d+))$", RegexOptions.CultureInvariant)]
    private static partial Regex Zone();
}
