namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Right-of-way signs relevant to junction control.</summary>
[Flags]
public enum SignKinds
{
    None = 0,
    Stop = 1,
    GiveWay = 2,
    PriorityRoad = 4,
    PriorityRoadEnd = 8,
}

/// <summary>
/// Reads right-of-way signs from OSM (#100, #101): <c>highway=stop|give_way</c>, <c>traffic_sign=*</c> with
/// national codes (DE, AT, CH) or human-readable values, and <c>priority_road=*</c> on ways.
/// </summary>
public static class SignRule
{
    // Codes per country; prefixes match variants such as "DE:205-10".
    private static readonly (string Code, SignKinds Kind)[] Codes =
    [
        ("DE:206", SignKinds.Stop),
        ("DE:205", SignKinds.GiveWay),
        ("DE:306", SignKinds.PriorityRoad),
        ("DE:307", SignKinds.PriorityRoadEnd),
        ("AT:§52.c.24", SignKinds.Stop),
        ("AT:§52.c.23", SignKinds.GiveWay),
        ("AT:§52.c.25a", SignKinds.PriorityRoad),
        ("AT:§52.c.25b", SignKinds.PriorityRoadEnd),
        ("AT:§52/24", SignKinds.Stop),
        ("AT:§52/23", SignKinds.GiveWay),
        ("AT:§52/25a", SignKinds.PriorityRoad),
        ("AT:§52/25b", SignKinds.PriorityRoadEnd),
        ("CH:3.01", SignKinds.Stop),
        ("CH:3.02", SignKinds.GiveWay),
        ("CH:3.03", SignKinds.PriorityRoad),
        ("CH:3.04", SignKinds.PriorityRoadEnd),
        ("FR:AB4", SignKinds.Stop),
        ("FR:AB3a", SignKinds.GiveWay),
        ("FR:AB6", SignKinds.PriorityRoad),
        ("FR:AB7", SignKinds.PriorityRoadEnd),
        ("IT:Fig.II.37", SignKinds.Stop),
        ("IT:Fig.II.36", SignKinds.GiveWay),
        ("NL:B7", SignKinds.Stop),
        ("NL:B6", SignKinds.GiveWay),
        ("NL:B1", SignKinds.PriorityRoad),
        ("GB:601", SignKinds.Stop),
        ("GB:602", SignKinds.GiveWay),
    ];

    /// <summary>Signs on a node or in a <c>traffic_sign</c> value.</summary>
    public static SignKinds ParseTrafficSign(string? value)
    {
        var result = SignKinds.None;
        foreach (var raw in (value ?? string.Empty).Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var token = raw.Split('[')[0];
            result |= token switch
            {
                "stop" => SignKinds.Stop,
                "give_way" or "yield" => SignKinds.GiveWay,
                "priority_road" => SignKinds.PriorityRoad,
                "priority_road_end" => SignKinds.PriorityRoadEnd,
                _ => Codes.Where(c => token.StartsWith(c.Code, StringComparison.OrdinalIgnoreCase)
                                      && (token.Length == c.Code.Length || !char.IsAsciiLetterOrDigit(token[c.Code.Length])))
                    .Select(c => c.Kind)
                    .FirstOrDefault(),
            };
        }

        return result;
    }

    /// <summary>Stop / give-way signs of a node from <c>highway=*</c> or <c>traffic_sign=*</c>.</summary>
    public static SignKinds NodeSigns(IReadOnlyDictionary<string, string> tags)
    {
        ArgumentNullException.ThrowIfNull(tags);
        var signs = Tags.Get(tags, "highway") switch
        {
            "stop" => SignKinds.Stop,
            "give_way" => SignKinds.GiveWay,
            _ => SignKinds.None,
        };
        return signs | ParseTrafficSign(Tags.Get(tags, "traffic_sign"));
    }

    /// <summary>Direction a node sign applies to, relative to the way: true = forward, false = backward, null = unknown.</summary>
    public static bool? Direction(IReadOnlyDictionary<string, string> tags)
    {
        ArgumentNullException.ThrowIfNull(tags);
        return (Tags.Get(tags, "direction") ?? Tags.Get(tags, "traffic_sign:direction")) switch
        {
            "forward" => true,
            "backward" => false,
            _ => null,
        };
    }

    /// <summary>A way that is a signed priority road (<c>priority_road=designated|yes_unposted</c> or the sign).</summary>
    public static bool IsPriorityRoad(IReadOnlyDictionary<string, string> tags)
    {
        ArgumentNullException.ThrowIfNull(tags);
        return Tags.Get(tags, "priority_road") is "designated" or "yes" or "yes_unposted"
               || (ParseTrafficSign(Tags.Get(tags, "traffic_sign")) & SignKinds.PriorityRoad) != 0;
    }

    /// <summary>Hierarchy rank including signed priority (signed priority roads outrank unsigned ones).</summary>
    public static int Rank(RoadClass roadClass, bool priorityRoad) => RoadClasses.Rank(roadClass) + (priorityRoad ? 100 : 0);
}
