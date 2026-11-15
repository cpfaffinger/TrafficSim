using TrafficSim.Domain.Geo;

namespace TrafficSim.Domain.Network;

/// <summary>A node of the lane graph: junction, link joint or network boundary.</summary>
public sealed class NetworkNode
{
    public required string Id { get; init; }

    public long? OsmId { get; init; }

    public Vec3 Position { get; set; }

    public NodeControl Control { get; set; }
}

/// <summary>One lane of a directed link. Index 0 is the rightmost lane.</summary>
public sealed class Lane
{
    public required string LinkId { get; init; }

    public required int Index { get; init; }

    public string Id => $"{LinkId}:{Index}";

    public double Width { get; set; }

    /// <summary>m/s.</summary>
    public double SpeedLimit { get; set; }

    public VehicleClasses Allowed { get; set; } = VehicleClasses.All;

    public TurnMarkings Turns { get; set; }

    public IReadOnlyList<Vec3> Geometry { get; set; } = [];

    public double Length => Polyline.Length(Geometry);
}

/// <summary>Boundary between two adjacent lanes of a link (ADR-0016).</summary>
/// <param name="RightLane">Index of the lane on the right.</param>
/// <param name="AllowLeft">Vehicles in the right lane may change to the left.</param>
/// <param name="AllowRight">Vehicles in the left lane may change to the right.</param>
public sealed record LaneBoundary(int RightLane, bool AllowLeft, bool AllowRight)
{
    public int LeftLane => RightLane + 1;

    public LaneMarking Marking => (AllowLeft, AllowRight) switch
    {
        (true, true) => LaneMarking.Dashed,
        (false, false) => LaneMarking.Solid,
        (true, false) => LaneMarking.SolidDashed,
        (false, true) => LaneMarking.DashedSolid,
    };
}

/// <summary>Sign at the end of a link's approach (#104).</summary>
public enum EndSign
{
    None,
    Stop,
    GiveWay,
    PriorityRoad,
}

/// <summary>An OSM node along a link (null id for points created by clipping at the area border).</summary>
public readonly record struct OsmNodeRef(long? Id, Vec3 Position);

/// <summary>A directed road segment between two nodes.</summary>
public sealed class Link
{
    public required string Id { get; init; }

    public long? OsmWayId { get; init; }

    /// <summary>True when the link runs in the OSM way's node order (false: against it).</summary>
    public bool OsmForward { get; set; } = true;

    /// <summary>OSM nodes of the link in travel direction (untrimmed positions), for editing (#105).</summary>
    public IReadOnlyList<OsmNodeRef> OsmNodes { get; set; } = [];

    /// <summary>Sign governing this link's approach at <see cref="To"/>.</summary>
    public EndSign EndSign { get; set; }

    /// <summary>OSM node following <see cref="From"/> along the way (identifies movements for edits, ADR-0010).</summary>
    public long? OsmAfterFrom { get; set; }

    /// <summary>OSM node preceding <see cref="To"/> along the way.</summary>
    public long? OsmBeforeTo { get; set; }

    public required string From { get; init; }

    public required string To { get; init; }

    public RoadClass RoadClass { get; init; }

    public string? Name { get; init; }

    public int Layer { get; init; }

    public Structure Structure { get; init; }

    public bool Roundabout { get; init; }

    public string? OppositeLinkId { get; set; }

    public bool ThroughTraffic { get; init; } = true;

    /// <summary>m/s.</summary>
    public double SpeedLimit { get; init; }

    public IReadOnlyList<Vec3> Geometry { get; set; } = [];

    public double Length => Polyline.Length(Geometry);

    public IReadOnlyList<Lane> Lanes { get; init; } = [];

    public IReadOnlyList<LaneBoundary> Boundaries { get; init; } = [];

    public EdgeMarking LeftEdge { get; init; }

    public double NoLaneChangeZone { get; set; }

    public ISet<string> Assumed { get; init; } = new SortedSet<string>(StringComparer.Ordinal);

    /// <summary>Vehicle dimension limits (#125); null when unrestricted. Routing avoids links a vehicle exceeds.</summary>
    public VehicleLimits? Limits { get; set; }

    public double TotalWidth => Lanes.Sum(l => l.Width);
}

/// <summary>Largest vehicle allowed on a link (#125): metres and tonnes, null = no limit.</summary>
public sealed record VehicleLimits(double? MaxLength = null, double? MaxWidth = null, double? MaxHeight = null, double? MaxWeight = null)
{
    public bool IsEmpty => MaxLength is null && MaxWidth is null && MaxHeight is null && MaxWeight is null;
}

/// <summary>A lane-to-lane movement through a node.</summary>
public sealed class Connector
{
    public required string Id { get; init; }

    public required string NodeId { get; init; }

    public required string FromLink { get; init; }

    public required int FromLane { get; init; }

    public required string ToLink { get; init; }

    public required int ToLane { get; init; }

    public Turn Turn { get; init; }

    public ConnectorPriority Priority { get; set; }

    public string? SignalGroup { get; set; }

    public IReadOnlyList<Vec3> Geometry { get; set; } = [];

    public double Length => Polyline.Length(Geometry);

    public IList<string> Conflicts { get; } = [];
}

/// <summary>A green interval within a signal cycle, seconds.</summary>
public readonly record struct GreenInterval(double Start, double End);

/// <summary>A signal group: the connectors switched together.</summary>
public sealed record SignalGroup(string Id, IReadOnlyList<GreenInterval> Green, double Amber);

/// <summary>A fixed-time signal plan for one node.</summary>
public sealed record SignalController(string NodeId, double Cycle, double Offset, IReadOnlyList<SignalGroup> Groups);

/// <summary>The compiled lane graph of an area (ADR-0009).</summary>
public sealed class RoadNetwork
{
    public required GeoPoint Origin { get; init; }

    public required BoundingBox Area { get; init; }

    /// <summary>The import polygon when the area is not a rectangle (#110).</summary>
    public GeoPolygon? Polygon { get; init; }

    public DateTimeOffset? OsmTimestamp { get; init; }

    public IReadOnlyList<NetworkNode> Nodes { get; init; } = [];

    public IReadOnlyList<Link> Links { get; init; } = [];

    public IReadOnlyList<Connector> Connectors { get; init; } = [];

    public IReadOnlyList<SignalController> Signals { get; init; } = [];

    public int LaneCount => Links.Sum(l => l.Lanes.Count);

    /// <summary>Stop/give-way signs that could not be attached to a junction approach.</summary>
    public int IgnoredSigns { get; init; }

    /// <summary>Terrain the network was compiled on (ADR-0018); null for flat networks.</summary>
    public TerrainGrid? Terrain { get; init; }

    /// <summary>Public transport lines mapped onto the links (#85, ADR-0019).</summary>
    public IReadOnlyList<TransitLine> TransitLines { get; set; } = [];

    /// <summary>Bus routes in the area that could not be mapped onto the links (dropped, never failing the import).</summary>
    public int DroppedTransitLines { get; set; }

    /// <summary>Pedestrian crossings (ADR-0020).</summary>
    public IReadOnlyList<Crossing> Crossings { get; init; } = [];
}
