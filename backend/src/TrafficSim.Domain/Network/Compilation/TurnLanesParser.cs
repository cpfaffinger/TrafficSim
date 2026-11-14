namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Parses <c>turn:lanes</c> values (#24).</summary>
public static class TurnLanesParser
{
    public static TurnMarkings ParseLane(string? value)
    {
        var result = TurnMarkings.None;
        foreach (var part in (value ?? string.Empty).Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            result |= part switch
            {
                "left" => TurnMarkings.Left,
                "slight_left" => TurnMarkings.SlightLeft,
                "sharp_left" => TurnMarkings.SharpLeft,
                "through" => TurnMarkings.Through,
                "right" => TurnMarkings.Right,
                "slight_right" => TurnMarkings.SlightRight,
                "sharp_right" => TurnMarkings.SharpRight,
                "reverse" => TurnMarkings.Reverse,
                "merge_to_left" => TurnMarkings.MergeToLeft,
                "merge_to_right" => TurnMarkings.MergeToRight,
                _ => TurnMarkings.None,
            };
        }

        return result;
    }

    /// <summary>Turn markings compatible with a geometric movement, best match first.</summary>
    public static IReadOnlyList<TurnMarkings> Compatible(Turn turn) => turn switch
    {
        Turn.Through => [TurnMarkings.Through, TurnMarkings.SlightLeft | TurnMarkings.SlightRight],
        Turn.Left => [TurnMarkings.Left, TurnMarkings.SlightLeft | TurnMarkings.SharpLeft],
        Turn.Right => [TurnMarkings.Right, TurnMarkings.SlightRight | TurnMarkings.SharpRight],
        Turn.SlightLeft => [TurnMarkings.SlightLeft, TurnMarkings.Left | TurnMarkings.Through],
        Turn.SlightRight => [TurnMarkings.SlightRight, TurnMarkings.Right | TurnMarkings.Through],
        Turn.SharpLeft => [TurnMarkings.SharpLeft, TurnMarkings.Left],
        Turn.SharpRight => [TurnMarkings.SharpRight, TurnMarkings.Right],
        _ => [TurnMarkings.Reverse, TurnMarkings.Left | TurnMarkings.SharpLeft],
    };

    /// <summary>Classifies a movement by the signed angle between approach and exit direction (+ = left).</summary>
    public static Turn Classify(double signedAngleDegrees)
    {
        var a = Math.Abs(signedAngleDegrees);
        var left = signedAngleDegrees > 0;
        return a switch
        {
            <= 20 => Turn.Through,
            <= 45 => left ? Turn.SlightLeft : Turn.SlightRight,
            <= 135 => left ? Turn.Left : Turn.Right,
            <= 170 => left ? Turn.SharpLeft : Turn.SharpRight,
            _ => Turn.Reverse,
        };
    }

    public static bool IsLeftish(Turn turn) => turn is Turn.Left or Turn.SlightLeft or Turn.SharpLeft or Turn.Reverse;

    public static bool IsRightish(Turn turn) => turn is Turn.Right or Turn.SlightRight or Turn.SharpRight;
}
