namespace TrafficSim.Domain.Network;

/// <summary>Defaults and rankings per road class.</summary>
public static class RoadClasses
{
    private static readonly Dictionary<string, RoadClass> ByTag = new(StringComparer.Ordinal)
    {
        ["motorway"] = RoadClass.Motorway,
        ["motorway_link"] = RoadClass.MotorwayLink,
        ["trunk"] = RoadClass.Trunk,
        ["trunk_link"] = RoadClass.TrunkLink,
        ["primary"] = RoadClass.Primary,
        ["primary_link"] = RoadClass.PrimaryLink,
        ["secondary"] = RoadClass.Secondary,
        ["secondary_link"] = RoadClass.SecondaryLink,
        ["tertiary"] = RoadClass.Tertiary,
        ["tertiary_link"] = RoadClass.TertiaryLink,
        ["unclassified"] = RoadClass.Unclassified,
        ["residential"] = RoadClass.Residential,
        ["living_street"] = RoadClass.LivingStreet,
        ["service"] = RoadClass.Service,
        ["road"] = RoadClass.Road,
        ["busway"] = RoadClass.Busway,
    };

    private static readonly Dictionary<RoadClass, string> ToTagMap = ByTag.ToDictionary(kv => kv.Value, kv => kv.Key);

    public static bool TryParse(string? highway, out RoadClass roadClass) => ByTag.TryGetValue(highway ?? string.Empty, out roadClass);

    public static string ToTag(RoadClass roadClass) => ToTagMap[roadClass];

    /// <summary>Hierarchy rank used for priority decisions (higher = more important).</summary>
    public static int Rank(RoadClass c) => c switch
    {
        RoadClass.Motorway => 10,
        RoadClass.Trunk => 9,
        RoadClass.Primary => 8,
        RoadClass.Secondary => 7,
        RoadClass.Tertiary => 6,
        RoadClass.MotorwayLink or RoadClass.TrunkLink => 5,
        RoadClass.PrimaryLink or RoadClass.SecondaryLink or RoadClass.TertiaryLink => 4,
        RoadClass.Unclassified or RoadClass.Road => 3,
        RoadClass.Residential or RoadClass.Busway => 2,
        _ => 1,
    };

    /// <summary>Minor streets where unsigned junctions follow right-before-left.</summary>
    public static bool IsMinorStreet(RoadClass c) =>
        c is RoadClass.Unclassified or RoadClass.Residential or RoadClass.LivingStreet or RoadClass.Service or RoadClass.Road;

    public static bool IsMotorwayLike(RoadClass c) => c is RoadClass.Motorway or RoadClass.Trunk;

    /// <summary>Default speed limit in km/h when OSM has none (flagged as assumed).</summary>
    public static double DefaultSpeedKmh(RoadClass c) => c switch
    {
        RoadClass.Motorway => 130,
        RoadClass.Trunk => 100,
        RoadClass.MotorwayLink => 80,
        RoadClass.TrunkLink => 60,
        RoadClass.LivingStreet => 7,
        RoadClass.Service => 20,
        RoadClass.Residential => 30,
        _ => 50,
    };

    /// <summary>Default lane width in metres.</summary>
    public static double DefaultLaneWidth(RoadClass c) => c switch
    {
        RoadClass.Motorway or RoadClass.Trunk => 3.75,
        RoadClass.MotorwayLink or RoadClass.TrunkLink or RoadClass.Primary or RoadClass.Secondary => 3.5,
        RoadClass.LivingStreet or RoadClass.Service => 2.75,
        _ => 3.25,
    };

    /// <summary>Default lanes per direction on one-way roads.</summary>
    public static int DefaultOneWayLanes(RoadClass c) => IsMotorwayLike(c) ? 2 : 1;
}
