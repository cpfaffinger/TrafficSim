namespace TrafficSim.Domain.Network.Compilation;

/// <summary>
/// A movement through an OSM node, identified by the OSM nodes adjacent to the junction on the
/// incoming and outgoing way (stable across recompilations, unlike compiled link ids).
/// </summary>
public readonly record struct MovementKey(long NodeId, long FromNeighbour, long ToNeighbour);

/// <summary>User-defined signal timing for one OSM node (Phase 7 signal plan editor).</summary>
/// <param name="Cycle">Cycle time in seconds.</param>
/// <param name="Offset">Offset in seconds.</param>
/// <param name="PhaseGreen">Green duration per phase (seconds); phases run in order separated by amber + all-red.</param>
/// <param name="ApproachPhase">Phase index per approach, keyed by the approach's neighbour OSM node; unlisted approaches keep the automatic grouping.</param>
public sealed record SignalPlanOverride(double Cycle, double Offset, IReadOnlyList<double> PhaseGreen, IReadOnlyDictionary<long, int> ApproachPhase);

/// <summary>Edits that act on the compiled lane graph rather than on OSM tags.</summary>
public sealed class CompilerOverrides
{
    /// <summary>Explicit lane mappings per movement: incoming lane index → outgoing lane indices.</summary>
    public Dictionary<MovementKey, Dictionary<int, IReadOnlyList<int>>> LaneConnections { get; } = [];

    /// <summary>Forbidden movements (turn restrictions).</summary>
    public HashSet<MovementKey> BannedMovements { get; } = [];

    public Dictionary<long, SignalPlanOverride> SignalPlans { get; } = [];

    public bool IsEmpty => LaneConnections.Count == 0 && BannedMovements.Count == 0 && SignalPlans.Count == 0;
}
