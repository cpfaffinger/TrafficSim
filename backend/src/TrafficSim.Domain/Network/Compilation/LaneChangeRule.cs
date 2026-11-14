namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Lane boundaries and centre lines from <c>change:lanes</c>, <c>change</c>, <c>overtaking</c>, <c>divider</c> (#94, ADR-0016).</summary>
public static class LaneChangeRule
{
    /// <param name="perLane">change values indexed by lane (0 = rightmost) or null.</param>
    /// <param name="general">Value of <c>change[:direction]</c> applying to all lanes, or null.</param>
    /// <param name="laneCount">Number of lanes.</param>
    public static IReadOnlyList<LaneBoundary> Boundaries(IReadOnlyList<string>? perLane, string? general, int laneCount)
    {
        var result = new List<LaneBoundary>(Math.Max(0, laneCount - 1));
        for (var right = 0; right < laneCount - 1; right++)
        {
            var rightValue = perLane?[right] ?? general ?? "yes";
            var leftValue = perLane?[right + 1] ?? general ?? "yes";
            result.Add(new LaneBoundary(right, MayChangeLeft(rightValue), MayChangeRight(leftValue)));
        }

        return result;
    }

    public static bool MayChangeLeft(string value) => value is "yes" or "not_right" or "only_left" or "";

    public static bool MayChangeRight(string value) => value is "yes" or "not_left" or "only_right" or "";

    /// <summary>Marking left of the leftmost lane of a link.</summary>
    public static EdgeMarking LeftEdge(IReadOnlyDictionary<string, string> tags, OneWay oneWay, TravelDirection direction, int forward, int backward)
    {
        ArgumentNullException.ThrowIfNull(tags);
        if (oneWay != OneWay.No)
        {
            return EdgeMarking.Edge;
        }

        switch (Tags.Get(tags, "divider"))
        {
            case "solid_line":
                return EdgeMarking.CentreSolid;
            case "double_solid_line" or "physical" or "barrier" or "kerb" or "street_island":
                return EdgeMarking.DoubleSolid;
            case "dashed_line":
                return EdgeMarking.CentreDashed;
        }

        var overtaking = Tags.GetDirectional(tags, "overtaking", direction);
        if (Tags.IsNo(overtaking))
        {
            return EdgeMarking.CentreSolid;
        }

        return forward >= 2 && backward >= 2 && overtaking is null ? EdgeMarking.CentreSolid : EdgeMarking.CentreDashed;
    }
}
