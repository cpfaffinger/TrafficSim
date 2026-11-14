using System.Globalization;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Providers.Overpass;

/// <summary>Builds the Overpass QL query for the drivable road network of an area.</summary>
internal static class OverpassQuery
{
    /// <summary>Road classes that carry motor vehicle traffic (ADR-0005).</summary>
    public const string HighwayPattern =
        "^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|" +
        "tertiary|tertiary_link|unclassified|residential|living_street|service|road|busway)$";

    /// <summary>Service road subtypes that do not matter for traffic flow.</summary>
    public const string ExcludedServicePattern = "^(parking_aisle|driveway|drive-through|emergency_access)$";

    public static string Build(BoundingBox area, int timeoutSeconds)
    {
        ArgumentNullException.ThrowIfNull(area);
        var bbox = string.Create(CultureInfo.InvariantCulture, $"{area.South:F7},{area.West:F7},{area.North:F7},{area.East:F7}");
        var timeout = timeoutSeconds.ToString(CultureInfo.InvariantCulture);
        return $"[out:json][timeout:{timeout}];" +
            $"(way[\"highway\"~\"{HighwayPattern}\"][\"service\"!~\"{ExcludedServicePattern}\"][\"area\"!=\"yes\"]({bbox}););" +
            "(._;>;);out body qt;";
    }
}
