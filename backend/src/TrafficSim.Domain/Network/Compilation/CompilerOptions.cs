namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Tunables of the OSM → lane graph compiler (defaults are flagged as assumed where they apply).</summary>
public sealed class CompilerOptions
{
    /// <summary>Signal nodes this close to a junction control that junction (OSM tags signals on approaches).</summary>
    public double SignalCaptureMetres { get; init; } = 35;

    /// <summary>Stop / give-way signs apply to the next junction in their direction up to this road distance (#102).</summary>
    public double SignCaptureMetres { get; init; } = 60;

    /// <summary>Solid approach zone before signalised junctions (no lane changes).</summary>
    public double SolidApproachMetres { get; init; } = 30;

    public double SignalCycleSeconds { get; init; } = 90;

    public double AmberSeconds { get; init; } = 3;

    public double AllRedSeconds { get; init; } = 2;

    /// <summary>
    /// Signal nodes linked by roads up to this long belong to one junction (dual carriageways, slip roads) and
    /// run one coordinated plan (#117).
    /// </summary>
    public double SignalClusterMetres { get; init; } = 40;

    /// <summary>
    /// Links between signal nodes shorter than this cannot hold a waiting vehicle clear of both junctions: the
    /// movements out of them are green whenever a movement into them is (#117). 20 m covers an articulated truck
    /// (16.5 m + gap), which the simulation also makes pass both junctions in one go (#126).
    /// </summary>
    public double SignalChainMetres { get; init; } = 20;

    /// <summary>Terrain under the network (ADR-0018); null keeps the network flat apart from grade separation.</summary>
    public TerrainGrid? Terrain { get; init; }

    /// <summary>Roundabouts with a shorter ring centre line are too tight for articulated trucks (#125).</summary>
    public double TightRoundaboutMetres { get; init; } = 70;

    /// <summary>Assumed length limit (m) on the ring of a tight roundabout: rigid trucks and buses fit.</summary>
    public double TightRoundaboutMaxLength { get; init; } = 12;

    /// <summary>Dead-end pieces of minor roads shorter than this are dropped (driveway stubs, #127).</summary>
    public double StubMetres { get; init; } = 30;

    /// <summary>Which roads to build (#131): all, or only major roads / motorways with their ramps.</summary>
    public RoadSelection Roads { get; init; } = RoadSelection.All;
}

/// <summary>Road classes an import keeps (#131); the OSM data stays the same, the compiler drops the rest.</summary>
public enum RoadSelection
{
    /// <summary>Every drivable road.</summary>
    All,

    /// <summary>Motorways, trunk and primary roads (federal roads) with their links.</summary>
    Major,

    /// <summary>Motorways and trunk roads (expressways) with their links.</summary>
    Motorways,
}
