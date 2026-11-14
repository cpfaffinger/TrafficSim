using System.Text.Json;
using System.Text.Json.Serialization;

namespace TrafficSim.Application.Networks;

// DTOs of the network package format v1 (docs/architecture/network-package.md). They are the
// contract with the frontend and the sim core; change them only together with the spec.

public sealed record PackageOrigin(double Lat, double Lon);

public sealed record PackageNode(string Id, long? OsmId, double X, double Y, double Z, string Control);

public sealed record PackageLane(
    string Id,
    int Index,
    double Width,
    double SpeedLimit,
    IReadOnlyList<string> Allowed,
    IReadOnlyList<string> Turns,
    IReadOnlyList<double[]> Geometry,
    double Length);

public sealed record PackageBoundary(int RightLane, int LeftLane, string Marking, bool AllowLeft, bool AllowRight);

public sealed record PackageLink(
    string Id,
    long? OsmWayId,
    string From,
    string To,
    string RoadClass,
    string? Name,
    int Layer,
    string Structure,
    bool Roundabout,
    string? OppositeLink,
    bool ThroughTraffic,
    double Length,
    double SpeedLimit,
    IReadOnlyList<double[]> Geometry,
    IReadOnlyList<PackageLane> Lanes,
    IReadOnlyList<PackageBoundary> Boundaries,
    string LeftEdge,
    double NoLaneChangeZone,
    IReadOnlyList<string> Assumed,
    long? OsmAfterFrom = null,
    long? OsmBeforeTo = null,
    bool OsmForward = true);

public sealed record PackageConnector(
    string Id,
    string Node,
    string FromLink,
    int FromLane,
    string ToLink,
    int ToLane,
    string Turn,
    string Priority,
    string? SignalGroup,
    IReadOnlyList<double[]> Geometry,
    double Length,
    IReadOnlyList<string> Conflicts);

public sealed record PackageSignalGroup(string Id, IReadOnlyList<double[]> Green, double Amber);

public sealed record PackageSignal(string Node, double Cycle, double Offset, IReadOnlyList<PackageSignalGroup> Groups);

public sealed record PackageStats(int Nodes, int Links, int Lanes, int Connectors, int Signals);

public sealed record NetworkPackage(
    int FormatVersion,
    Guid? BaselineId,
    PackageOrigin Origin,
    double[] Bbox,
    DateTimeOffset? OsmTimestamp,
    IReadOnlyList<string> Attribution,
    IReadOnlyList<PackageNode> Nodes,
    IReadOnlyList<PackageLink> Links,
    IReadOnlyList<PackageConnector> Connectors,
    IReadOnlyList<PackageSignal> Signals,
    PackageStats Stats)
{
    public const int CurrentFormatVersion = 1;

    public static JsonSerializerOptions JsonOptions { get; } = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false,
    };
}
