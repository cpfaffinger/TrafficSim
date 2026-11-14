namespace TrafficSim.Domain.Network;

/// <summary>How pedestrians and vehicles share a crossing (ADR-0020).</summary>
public enum CrossingKind
{
    /// <summary>Marked crossing with pedestrian priority: vehicles stop for waiting pedestrians.</summary>
    Zebra,

    /// <summary>Signal-controlled crossing (mid-block push-button signal or junction crosswalk).</summary>
    Signal,

    /// <summary>Marked crossing without priority: pedestrians wait for a gap.</summary>
    Uncontrolled,

    /// <summary>Unmarked crossing point: pedestrians wait for a gap.</summary>
    Unmarked,
}

/// <summary>How a signalised crossing relates to its signal group.</summary>
public enum CrossingSignalMode
{
    /// <summary>Not signalised (or no signal group could be assigned).</summary>
    None,

    /// <summary>Pedestrians walk during the green of the group; turning vehicles yield to them.</summary>
    Parallel,

    /// <summary>Pedestrians request a pedestrian phase that turns the (vehicle) group red.</summary>
    Request,
}

/// <summary>
/// A directional link crossed by a crossing: the crossing's centre is <paramref name="Position"/> metres
/// from the link start; the link's lanes occupy <paramref name="SpanFrom"/>..<paramref name="SpanTo"/> metres
/// along the crossing, measured from its first kerb.
/// </summary>
public sealed record CrossingLink(string LinkId, double Position, double SpanFrom, double SpanTo);

/// <summary>A pedestrian crossing over a carriageway (ADR-0020).</summary>
public sealed class Crossing
{
    public required string Id { get; init; }

    /// <summary>OSM node of an explicitly mapped crossing; null for implicit crosswalks.</summary>
    public long? OsmId { get; init; }

    public CrossingKind Kind { get; init; }

    /// <summary>Signal node the crossing belongs to (junction or mid-block signal), if any.</summary>
    public string? NodeId { get; init; }

    public string? SignalGroup { get; init; }

    public CrossingSignalMode SignalMode { get; init; }

    /// <summary>Assumed crosswalk at a signalised junction leg (not mapped in OSM).</summary>
    public bool Implicit { get; init; }

    /// <summary>Kerb-to-kerb walking distance (m).</summary>
    public double Width { get; init; }

    /// <summary>Extent of the crossing along the road (m).</summary>
    public double Depth { get; init; }

    /// <summary>Estimated pedestrians per hour (both directions).</summary>
    public double Demand { get; init; }

    /// <summary>Kerb to kerb: first kerb (span origin) to second kerb.</summary>
    public IReadOnlyList<Vec3> Geometry { get; init; } = [];

    public IReadOnlyList<CrossingLink> Links { get; init; } = [];
}
