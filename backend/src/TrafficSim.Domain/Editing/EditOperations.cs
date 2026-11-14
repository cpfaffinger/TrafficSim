using System.Text.Json.Serialization;

namespace TrafficSim.Domain.Editing;

/// <summary>
/// A typed network edit (ADR-0010). Edits address OSM elements by id so a changeset can be re-applied
/// ("rebased") on a newer import of the same area. User-created elements use negative ids chosen by the
/// client (unique within the changeset).
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "op")]
[JsonDerivedType(typeof(SetWayTags), "set_way_tags")]
[JsonDerivedType(typeof(SetNodeTags), "set_node_tags")]
[JsonDerivedType(typeof(AddWay), "add_way")]
[JsonDerivedType(typeof(InsertNode), "insert_node")]
[JsonDerivedType(typeof(RemoveWay), "remove_way")]
[JsonDerivedType(typeof(ConvertToRoundabout), "convert_to_roundabout")]
[JsonDerivedType(typeof(SetLaneConnections), "set_lane_connections")]
[JsonDerivedType(typeof(BanMovement), "ban_movement")]
[JsonDerivedType(typeof(SetSignalPlan), "set_signal_plan")]
public abstract record EditOperation;

/// <summary>
/// Sets (value) or removes (null) tags on a way, or on the part between two of its nodes — the way is split
/// there first. Covers lanes, turn lanes, speed limits, access, lane markings, bridges/tunnels, one-way.
/// </summary>
public sealed record SetWayTags(long WayId, long? FromNode, long? ToNode, IReadOnlyDictionary<string, string?> Tags) : EditOperation;

/// <summary>Sets or removes node tags, e.g. <c>highway=traffic_signals|stop|give_way|mini_roundabout</c>.</summary>
public sealed record SetNodeTags(long NodeId, IReadOnlyDictionary<string, string?> Tags) : EditOperation;

/// <summary>A node of a new way: an existing node (positive id or earlier new node) or a new one with a position.</summary>
public sealed record WayNode(long Id, double? Lat = null, double? Lon = null);

/// <summary>Adds a new road (bridges/tunnels via tags). <paramref name="WayId"/> must be negative.</summary>
public sealed record AddWay(long WayId, IReadOnlyList<WayNode> Nodes, IReadOnlyDictionary<string, string> Tags) : EditOperation;

/// <summary>Inserts a new node (negative id) into an existing way after <paramref name="AfterNode"/>, e.g. to attach a new road.</summary>
public sealed record InsertNode(long WayId, long AfterNode, long NodeId, double Lat, double Lon) : EditOperation;

/// <summary>Removes a way, or its part between two nodes.</summary>
public sealed record RemoveWay(long WayId, long? FromNode, long? ToNode) : EditOperation;

/// <summary>Replaces a junction node by a roundabout ring of the given radius (metres).</summary>
public sealed record ConvertToRoundabout(long NodeId, double Radius) : EditOperation;

/// <summary>Sets which outgoing lanes an incoming lane connects to for one movement (empty = none from that lane).</summary>
public sealed record SetLaneConnections(long NodeId, long FromNeighbour, int FromLane, long ToNeighbour, IReadOnlyList<int> ToLanes) : EditOperation;

/// <summary>Forbids a movement (turn restriction).</summary>
public sealed record BanMovement(long NodeId, long FromNeighbour, long ToNeighbour) : EditOperation;

/// <summary>Sets the timing of a signalised node; approach keys are neighbour OSM node ids.</summary>
public sealed record SetSignalPlan(long NodeId, double Cycle, double Offset, IReadOnlyList<double> PhaseGreen, IReadOnlyDictionary<long, int>? ApproachPhase) : EditOperation;
