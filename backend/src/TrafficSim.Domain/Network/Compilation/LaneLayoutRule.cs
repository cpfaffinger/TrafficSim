namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Lane counts per direction of a way (#23).</summary>
/// <param name="OneWay">Driving directions.</param>
/// <param name="Forward">Lanes in way direction.</param>
/// <param name="Backward">Lanes against way direction.</param>
/// <param name="BothWays">Shared centre lanes (<c>lanes:both_ways</c>), rendered as a gap.</param>
/// <param name="Assumed">True when counts came from defaults.</param>
public sealed record LaneLayout(OneWay OneWay, int Forward, int Backward, int BothWays, bool Assumed)
{
    public int For(TravelDirection direction) => direction == TravelDirection.Forward ? Forward : Backward;
}

/// <summary>Interprets <c>oneway</c>, <c>lanes</c>, <c>lanes:forward/backward/both_ways</c> and turn-lane counts.</summary>
public static class LaneLayoutRule
{
    public const int MaxLanes = 8;

    public static OneWay ParseOneWay(IReadOnlyDictionary<string, string> tags, RoadClass roadClass)
    {
        var oneway = Tags.Get(tags, "oneway");
        if (oneway is "-1" or "reverse")
        {
            return OneWay.Backward;
        }

        if (Tags.IsYes(oneway))
        {
            return OneWay.Forward;
        }

        if (Tags.IsNo(oneway))
        {
            return OneWay.No;
        }

        var junction = Tags.Get(tags, "junction");
        return junction is "roundabout" or "circular" || roadClass == RoadClass.Motorway ? OneWay.Forward : OneWay.No;
    }

    public static LaneLayout Resolve(IReadOnlyDictionary<string, string> tags, RoadClass roadClass)
    {
        ArgumentNullException.ThrowIfNull(tags);
        var oneWay = ParseOneWay(tags, roadClass);
        var lanes = Positive(Tags.GetInt(tags, "lanes"));
        var forward = Positive(Tags.GetInt(tags, "lanes:forward"));
        var backward = Positive(Tags.GetInt(tags, "lanes:backward"));
        var bothWays = Math.Max(0, Tags.GetInt(tags, "lanes:both_ways") ?? 0);
        var turnForward = TurnLaneCount(tags, oneWay == OneWay.Forward ? "turn:lanes" : "turn:lanes:forward") ?? TurnLaneCount(tags, "turn:lanes:forward");
        var turnBackward = TurnLaneCount(tags, oneWay == OneWay.Backward ? "turn:lanes" : "turn:lanes:backward") ?? TurnLaneCount(tags, "turn:lanes:backward");

        switch (oneWay)
        {
            case OneWay.Forward:
            {
                var n = forward ?? lanes ?? turnForward;
                return new LaneLayout(oneWay, Clamp(n ?? RoadClasses.DefaultOneWayLanes(roadClass)), 0, 0, n is null);
            }

            case OneWay.Backward:
            {
                var n = backward ?? lanes ?? turnBackward;
                return new LaneLayout(oneWay, 0, Clamp(n ?? RoadClasses.DefaultOneWayLanes(roadClass)), 0, n is null);
            }
        }

        if (forward is { } f && backward is { } b)
        {
            return new LaneLayout(oneWay, Clamp(f), Clamp(b), bothWays, false);
        }

        if (lanes is { } total)
        {
            var rest = total - bothWays;
            if (forward is { } f2)
            {
                return new LaneLayout(oneWay, Clamp(f2), Clamp(rest - f2), bothWays, false);
            }

            if (backward is { } b2)
            {
                return new LaneLayout(oneWay, Clamp(rest - b2), Clamp(b2), bothWays, false);
            }

            var half = (rest + 1) / 2;
            return new LaneLayout(oneWay, Clamp(half), Clamp(rest - half), bothWays, rest % 2 != 0);
        }

        return new LaneLayout(oneWay, Clamp(forward ?? turnForward ?? 1), Clamp(backward ?? turnBackward ?? 1), bothWays,
            (forward ?? turnForward) is null || (backward ?? turnBackward) is null);
    }

    private static int? TurnLaneCount(IReadOnlyDictionary<string, string> tags, string key) =>
        Tags.Get(tags, key) is { } raw ? Tags.SplitLanes(raw).Count : null;

    private static int? Positive(int? value) => value is > 0 ? value : null;

    private static int Clamp(int value) => Math.Clamp(value, 1, MaxLanes);
}
