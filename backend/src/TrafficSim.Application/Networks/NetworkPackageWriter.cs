using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Serialization;
using TrafficSim.Domain.Network;

namespace TrafficSim.Application.Networks;

/// <summary>Maps a compiled <see cref="RoadNetwork"/> to the network package v1 and serialises it.</summary>
public static class NetworkPackageWriter
{
    public static NetworkPackage ToPackage(RoadNetwork network, Guid? baselineId, IReadOnlyList<string> attribution)
    {
        ArgumentNullException.ThrowIfNull(network);
        ArgumentNullException.ThrowIfNull(attribution);
        return new NetworkPackage(
            NetworkPackage.CurrentFormatVersion,
            baselineId,
            new PackageOrigin(network.Origin.Latitude, network.Origin.Longitude),
            [network.Area.West, network.Area.South, network.Area.East, network.Area.North],
            network.OsmTimestamp,
            attribution,
            network.Nodes.Select(n => new PackageNode(n.Id, n.OsmId, R(n.Position.X), R(n.Position.Y), R(n.Position.Z), Snake(n.Control))).ToList(),
            network.Links.Select(MapLink).ToList(),
            network.Connectors.Select(c => new PackageConnector(
                c.Id, c.NodeId, c.FromLink, c.FromLane, c.ToLink, c.ToLane, Snake(c.Turn), Snake(c.Priority), c.SignalGroup,
                Points(c.Geometry), R(c.Length), c.Conflicts.ToList())).ToList(),
            network.Signals.Select(s => new PackageSignal(s.NodeId, s.Cycle, s.Offset,
                s.Groups.Select(g => new PackageSignalGroup(g.Id, g.Green.Select(i => new[] { i.Start, i.End }).ToList(), g.Amber)).ToList())).ToList(),
            new PackageStats(network.Nodes.Count, network.Links.Count, network.LaneCount, network.Connectors.Count, network.Signals.Count, network.IgnoredSigns),
            network.Polygon?.Ring.Select(p => new[] { p.Longitude, p.Latitude }).ToList(),
            PackageTerrain.From(network.Terrain));
    }

    public static byte[] SerializeGzip(NetworkPackage package)
    {
        using var buffer = new MemoryStream();
        using (var gzip = new GZipStream(buffer, CompressionLevel.Optimal, leaveOpen: true))
        {
            JsonSerializer.Serialize(gzip, package, NetworkPackage.JsonOptions);
        }

        return buffer.ToArray();
    }

    public static NetworkPackage DeserializeGzip(byte[] gzipJson)
    {
        using var input = new GZipStream(new MemoryStream(gzipJson), CompressionMode.Decompress);
        return JsonSerializer.Deserialize<NetworkPackage>(input, NetworkPackage.JsonOptions)
            ?? throw new JsonException("empty network package");
    }

    private static PackageLink MapLink(Link l) => new(
        l.Id,
        l.OsmWayId,
        l.From,
        l.To,
        RoadClasses.ToTag(l.RoadClass),
        l.Name,
        l.Layer,
        Snake(l.Structure),
        l.Roundabout,
        l.OppositeLinkId,
        l.ThroughTraffic,
        R(l.Length),
        R(l.SpeedLimit),
        Points(l.Geometry),
        l.Lanes.Select(lane => new PackageLane(
            lane.Id,
            lane.Index,
            R(lane.Width),
            R(lane.SpeedLimit),
            Flags(lane.Allowed),
            Flags(lane.Turns),
            Points(lane.Geometry),
            R(lane.Length))).ToList(),
        l.Boundaries.Select(b => new PackageBoundary(b.RightLane, b.LeftLane, Snake(b.Marking), b.AllowLeft, b.AllowRight)).ToList(),
        Snake(l.LeftEdge),
        R(l.NoLaneChangeZone),
        l.Assumed.ToList(),
        l.OsmAfterFrom,
        l.OsmBeforeTo,
        l.OsmForward,
        Snake(l.EndSign),
        l.OsmNodes.Select(n => new PackageOsmNode(n.Id, R(n.Position.X), R(n.Position.Y))).ToList());

    private static List<double[]> Points(IReadOnlyList<Vec3> points) => points.Select(p => new[] { R(p.X), R(p.Y), R(p.Z) }).ToList();

    private static double R(double v) => Math.Round(v, 3);

    private static List<string> Flags<T>(T value)
        where T : struct, Enum =>
        Enum.GetValues<T>()
            .Where(f => Convert.ToInt64(f, System.Globalization.CultureInfo.InvariantCulture) is var bits && bits != 0 && (bits & (bits - 1)) == 0 && value.HasFlag(f))
            .Select(f => Snake(f))
            .ToList();

    internal static string Snake<T>(T value)
        where T : struct, Enum => JsonNamingPolicy.SnakeCaseLower.ConvertName(value.ToString());
}
