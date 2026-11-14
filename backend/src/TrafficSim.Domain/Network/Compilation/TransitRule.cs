using System.Globalization;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Domain.Network.Compilation;

/// <summary>
/// Maps OSM bus and trolleybus route relations (PTv2, ADR-0019) onto the compiled lane graph (#85).
/// <list type="number">
/// <item>The member ways (in relation order) are oriented by their shared nodes into OSM node paths;
/// a way may be traversed partially (the route joins or leaves it at an inner node). Missing ways
/// (outside the area, not drivable) split the path.</item>
/// <item>Each directed OSM segment of a path is looked up among the links (clip points at the area
/// border resolve to the way segment they lie on). Consecutive links must be joined by a connector
/// usable by buses; gaps inside the network are bridged by the shortest bus path of at most
/// <see cref="MaxBridgeMetres"/>, never across the area border.</item>
/// <item>The longest connected part is the line: it enters at a boundary node or starts mid-network,
/// and leaves or ends likewise. Routes without any usable part are dropped (counted, never failing).</item>
/// <item>Stops (stop positions, else platforms within <see cref="StopCaptureMetres"/>) are projected
/// onto the line's links in driving order; <c>bus_bay</c> on the stop, platform or way marks bays.</item>
/// </list>
/// </summary>
public static class TransitRule
{
    /// <summary>Longest detour (m) used to bridge a gap in a route inside the network.</summary>
    public const double MaxBridgeMetres = 400;

    /// <summary>Largest distance (m) of a platform from the line's links.</summary>
    public const double StopCaptureMetres = 30;

    /// <summary>A stop position and its platform closer than this (m) form one stop.</summary>
    private const double StopMergeMetres = 50;

    public static void Apply(RoadNetwork network, OsmDataSet data)
    {
        ArgumentNullException.ThrowIfNull(network);
        ArgumentNullException.ThrowIfNull(data);
        var routes = data.Relations.Where(TransitRelations.IsBusRoute).OrderBy(r => r.Id).ToList();
        if (routes.Count == 0)
        {
            return;
        }

        var masters = new Dictionary<long, OsmRelation>();
        foreach (var master in data.Relations.Where(r => Tag(r.Tags, "type") == "route_master").OrderBy(r => r.Id))
        {
            foreach (var m in master.Members.Where(m => m.Type == OsmMemberType.Relation))
            {
                masters.TryAdd(m.Ref, master);
            }
        }

        var context = new Context(network, data);
        var lines = new List<TransitLine>();
        var dropped = 0;
        foreach (var route in routes)
        {
            var id = $"t{lines.Count.ToString(CultureInfo.InvariantCulture)}";
            if (context.Map(route, masters.GetValueOrDefault(route.Id), id) is { } line)
            {
                lines.Add(line);
            }
            else
            {
                dropped++;
            }
        }

        network.TransitLines = lines;
        network.DroppedTransitLines = dropped;
    }

    /// <summary>
    /// Headway in seconds from an OSM <c>interval</c> value: minutes (<c>10</c>), <c>HH:MM</c>,
    /// <c>HH:MM:SS</c> or a range (<c>5-10</c>, mean). Null when unparsable or outside 30 s to 6 h.
    /// </summary>
    public static double? ParseInterval(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var parts = value.Split('-', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var seconds = parts.Select(ParseDuration).ToList();
        if (seconds.Count is 0 or > 2 || seconds.Any(s => s is null))
        {
            return null;
        }

        var mean = seconds.Average(s => s!.Value);
        return mean is >= 30 and <= 6 * 3600 ? mean : null;
    }

    private static double? ParseDuration(string text)
    {
        var fields = text.Split(':');
        if (fields.Length > 3 || !fields.All(f => double.TryParse(f, NumberStyles.Float, CultureInfo.InvariantCulture, out var x) && x >= 0))
        {
            return null;
        }

        var v = fields.Select(f => double.Parse(f, CultureInfo.InvariantCulture)).ToList();
        return v.Count switch
        {
            1 => v[0] * 60,
            2 => (v[0] * 3600) + (v[1] * 60),
            _ => (v[0] * 3600) + (v[1] * 60) + v[2],
        };
    }

    private static string? Tag(IReadOnlyDictionary<string, string> tags, string key) => Tags.Get(tags, key);

    private static bool IsBay(string? value) => value is not null && value != "no";

    private sealed class Candidate
    {
        public required long OsmId { get; set; }

        public string? Name { get; set; }

        public required Vec3 Position { get; set; }

        public required bool StopPosition { get; set; }

        public bool Bay { get; set; }
    }

    private sealed class Context
    {
        private readonly OsmDataSet _data;
        private readonly LocalTangentPlane _plane;
        private readonly Dictionary<long, OsmWay> _ways = [];
        private readonly Dictionary<(long, long), Link> _segments = [];
        private readonly Dictionary<string, List<Link>> _next = new(StringComparer.Ordinal);
        private readonly Dictionary<string, NetworkNode> _nodes;

        public Context(RoadNetwork network, OsmDataSet data)
        {
            _data = data;
            _plane = new LocalTangentPlane(network.Origin);
            _nodes = network.Nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
            foreach (var way in data.Ways)
            {
                _ways.TryAdd(way.Id, way);
            }

            var links = network.Links.ToDictionary(l => l.Id, StringComparer.Ordinal);
            foreach (var link in network.Links.Where(AllowsBus))
            {
                if (link.OsmWayId is not { } wayId || !_ways.TryGetValue(wayId, out var way))
                {
                    continue;
                }

                for (var k = 0; k < link.OsmNodes.Count - 1; k++)
                {
                    if (SegmentEnds(link, way, k) is ({ } a, { } b))
                    {
                        _segments.TryAdd((a, b), link);
                    }
                }
            }

            foreach (var c in network.Connectors)
            {
                var from = links[c.FromLink];
                var to = links[c.ToLink];
                if ((from.Lanes[c.FromLane].Allowed & to.Lanes[c.ToLane].Allowed & VehicleClasses.Bus) == 0)
                {
                    continue;
                }

                if (!_next.TryGetValue(from.Id, out var list))
                {
                    _next[from.Id] = list = [];
                }

                if (!list.Contains(to))
                {
                    list.Add(to);
                }
            }
        }

        public TransitLine? Map(OsmRelation route, OsmRelation? master, string id)
        {
            var chunks = new List<List<Link>>();
            foreach (var path in Paths(route))
            {
                List<Link>? current = null;
                for (var j = 0; j < path.Count - 1; j++)
                {
                    if (!_segments.TryGetValue((path[j], path[j + 1]), out var link))
                    {
                        current = null;
                        continue;
                    }

                    if (current is not null && current[^1] == link)
                    {
                        continue;
                    }

                    if (current is null || !Connected(current[^1], link))
                    {
                        current = [];
                        chunks.Add(current);
                    }

                    current.Add(link);
                }
            }

            // Join consecutive parts directly or through a short bridge inside the network.
            var merged = new List<List<Link>>();
            foreach (var chunk in chunks)
            {
                if (merged.Count > 0 && Join(merged[^1], chunk) is { } bridge)
                {
                    merged[^1].AddRange(bridge);
                    merged[^1].AddRange(chunk);
                }
                else
                {
                    merged.Add(chunk);
                }
            }

            var best = merged.OrderByDescending(c => c.Sum(l => l.Length)).FirstOrDefault();
            if (best is null || best.Count == 0)
            {
                return null;
            }

            var tags = route.Tags;
            var masterTags = master?.Tags ?? OsmTags.Empty;
            return new TransitLine
            {
                Id = id,
                OsmId = route.Id,
                Ref = Tag(tags, "ref") ?? Tag(masterTags, "ref"),
                Name = Tag(tags, "name") ?? Tag(masterTags, "name"),
                Mode = Tag(tags, "route") ?? "bus",
                Colour = Tag(tags, "colour") ?? Tag(masterTags, "colour"),
                Headway = ParseInterval(Tag(tags, "interval")) ?? ParseInterval(Tag(masterTags, "interval")),
                Links = best.Select(l => l.Id).ToList(),
                Stops = Stops(route, best, id),
            };
        }

        private static bool AllowsBus(Link link) => link.Lanes.Any(l => (l.Allowed & VehicleClasses.Bus) != 0);

        private bool Connected(Link a, Link b) => _next.TryGetValue(a.Id, out var list) && list.Contains(b);

        /// <summary>Links between two parts (empty when directly connected), null when they cannot be joined.</summary>
        private List<Link>? Join(List<Link> before, List<Link> after)
        {
            var (a, b) = (before[^1], after[0]);
            if (Connected(a, b))
            {
                return [];
            }

            if (_nodes[a.To].Control == NodeControl.Boundary || _nodes[b.From].Control == NodeControl.Boundary)
            {
                return null;
            }

            // Dijkstra over bus movements; cost = length of the links in between.
            var dist = new Dictionary<string, double>(StringComparer.Ordinal) { [a.Id] = 0 };
            var previous = new Dictionary<string, Link>(StringComparer.Ordinal);
            var queue = new PriorityQueue<Link, double>();
            queue.Enqueue(a, 0);
            while (queue.TryDequeue(out var link, out var d))
            {
                if (d > dist[link.Id])
                {
                    continue;
                }

                foreach (var next in _next.GetValueOrDefault(link.Id) ?? [])
                {
                    if (next == b)
                    {
                        var path = new List<Link>();
                        for (var p = link; p != a; p = previous[p.Id])
                        {
                            path.Add(p);
                        }

                        path.Reverse();
                        return path;
                    }

                    var nd = d + next.Length;
                    if (nd <= MaxBridgeMetres && (!dist.TryGetValue(next.Id, out var old) || nd < old))
                    {
                        dist[next.Id] = nd;
                        previous[next.Id] = link;
                        queue.Enqueue(next, nd);
                    }
                }
            }

            return null;
        }

        // ------------------------------------------------------------ OSM node paths

        /// <summary>OSM node paths of the route's member ways, split where consecutive ways do not touch.</summary>
        private List<List<long>> Paths(OsmRelation route)
        {
            var members = route.Members
                .Where(m => m.Type == OsmMemberType.Way && !m.Role.StartsWith("platform", StringComparison.Ordinal) && !m.Role.StartsWith("stop", StringComparison.Ordinal))
                .ToList();
            var runs = new List<List<(OsmWay Way, string Role)>>();
            List<(OsmWay Way, string Role)>? run = null;
            foreach (var m in members)
            {
                if (!_ways.TryGetValue(m.Ref, out var way))
                {
                    run = null;
                    continue;
                }

                if (run is null || !run[^1].Way.NodeIds.Intersect(way.NodeIds).Any())
                {
                    run = [];
                    runs.Add(run);
                }

                run.Add((way, m.Role));
            }

            return runs.Select(Path).ToList();
        }

        private static List<long> Path(List<(OsmWay Way, string Role)> run)
        {
            var path = new List<long>();
            long? entry = null;
            for (var i = 0; i < run.Count; i++)
            {
                var (way, role) = run[i];
                var ids = way.NodeIds;
                var last = ids.Count - 1;
                var knownEntry = entry is { } e ? IndexOf(ids, e) : null;
                var knownExit = i + 1 < run.Count ? ExitIndex(way, run[i + 1].Way, knownEntry) : null;
                var oneway = OneWayOf(way, role);
                var entryIdx = knownEntry ?? knownExit switch
                {
                    null => oneway < 0 ? last : 0,
                    { } x => x == 0 ? last : x == last ? 0 : oneway > 0 ? 0 : oneway < 0 ? last : (x >= last - x ? 0 : last),
                };
                var exitIdx = knownExit ?? (entryIdx == 0 ? last
                    : entryIdx == last ? 0
                    : oneway > 0 ? last
                    : oneway < 0 ? 0
                    : entryIdx > last - entryIdx ? 0 : last);
                foreach (var node in Traverse(way, entryIdx, exitIdx))
                {
                    if (path.Count == 0 || path[^1] != node)
                    {
                        path.Add(node);
                    }
                }

                entry = ids[exitIdx];
            }

            return path;
        }

        /// <summary>+1 forward one-way (incl. roundabouts), −1 backward, 0 two-way.</summary>
        private static int OneWayOf(OsmWay way, string role)
        {
            if (role == "backward")
            {
                return -1;
            }

            if (role == "forward")
            {
                return 1;
            }

            var oneway = Tag(way.Tags, "oneway");
            return oneway == "-1" ? -1
                : Tags.IsYes(oneway) || Tag(way.Tags, "junction") is "roundabout" or "circular" ? 1
                : 0;
        }

        private static int? IndexOf(IReadOnlyList<long> ids, long id)
        {
            for (var k = 0; k < ids.Count; k++)
            {
                if (ids[k] == id)
                {
                    return k;
                }
            }

            return null;
        }

        /// <summary>Index in <paramref name="way"/> of the node where the route continues on <paramref name="next"/>.</summary>
        private static int? ExitIndex(OsmWay way, OsmWay next, int? entryIdx)
        {
            var ids = way.NodeIds;
            var shared = Enumerable.Range(0, ids.Count).Where(k => k != entryIdx && next.NodeIds.Contains(ids[k])).ToList();
            if (shared.Count == 0)
            {
                return null;
            }

            var ends = shared.Where(k => ids[k] == next.NodeIds[0] || ids[k] == next.NodeIds[^1]).ToList();
            var pool = ends.Count > 0 ? ends : shared;
            return entryIdx is { } e
                ? pool.OrderBy(k => Math.Abs(k - e)).First()
                : pool.OrderByDescending(k => k == 0 || k == ids.Count - 1).First();
        }

        private static List<long> Traverse(OsmWay way, int from, int to)
        {
            var ids = way.NodeIds;
            var closed = ids.Count > 2 && ids[0] == ids[^1];
            if (closed && OneWayOf(way, string.Empty) > 0 && to < from)
            {
                // Forward around a closed one-way ring (roundabout), across its closing node.
                return ids.Skip(from).Concat(ids.Skip(1).Take(to)).ToList();
            }

            return from <= to
                ? ids.Skip(from).Take(to - from + 1).ToList()
                : ids.Skip(to).Take(from - to + 1).Reverse().ToList();
        }

        /// <summary>OSM node ids at both ends of link segment <paramref name="k"/>; clip points resolve to the way segment they lie on.</summary>
        private (long? A, long? B) SegmentEnds(Link link, OsmWay way, int k)
        {
            var (a, b) = (link.OsmNodes[k].Id, link.OsmNodes[k + 1].Id);
            if (a is not null && b is not null)
            {
                return (a, b);
            }

            var ids = way.NodeIds;
            var step = link.OsmForward ? 1 : -1;
            if (a is null && b is { } known)
            {
                var i = Enumerable.Range(0, ids.Count).FirstOrDefault(x => ids[x] == known && x - step >= 0 && x - step < ids.Count, -1);
                return (i < 0 ? null : ids[i - step], b);
            }

            if (b is null && a is { } knownA)
            {
                var i = Enumerable.Range(0, ids.Count).FirstOrDefault(x => ids[x] == knownA && x + step >= 0 && x + step < ids.Count, -1);
                return (a, i < 0 ? null : ids[i + step]);
            }

            // Both ends are clip points: the way segment nearest to the link's middle.
            var mid = (link.OsmNodes[k].Position + link.OsmNodes[k + 1].Position) * 0.5;
            var best = -1;
            var bestDistance = double.MaxValue;
            for (var j = 0; j < ids.Count - 1; j++)
            {
                if (!_data.Nodes.TryGetValue(ids[j], out var p) || !_data.Nodes.TryGetValue(ids[j + 1], out var q))
                {
                    continue;
                }

                var (_, lateral) = Project([Local(p), Local(q)], mid);
                if (lateral < bestDistance)
                {
                    (best, bestDistance) = (j, lateral);
                }
            }

            return best < 0 ? (null, null) : link.OsmForward ? (ids[best], ids[best + 1]) : (ids[best + 1], ids[best]);
        }

        private Vec3 Local(OsmNode node)
        {
            var p = _plane.ToLocal(node.Location);
            return new Vec3(p.East, p.North);
        }

        // ------------------------------------------------------------ stops

        private List<TransitStop> Stops(OsmRelation route, List<Link> links, string lineId)
        {
            var candidates = new List<Candidate>();
            foreach (var m in route.Members.Where(m => m.Type == OsmMemberType.Node))
            {
                var role = m.Role;
                var stop = role.StartsWith("stop", StringComparison.Ordinal) || role.EndsWith(":stop", StringComparison.Ordinal);
                var platform = role.StartsWith("platform", StringComparison.Ordinal) || role.EndsWith(":platform", StringComparison.Ordinal);
                if ((!stop && !platform) || !_data.Nodes.TryGetValue(m.Ref, out var node))
                {
                    continue;
                }

                var c = new Candidate
                {
                    OsmId = node.Id,
                    Name = Tag(node.Tags, "name"),
                    Position = Local(node),
                    StopPosition = stop,
                    Bay = IsBay(Tag(node.Tags, "bus_bay")),
                };
                var prev = candidates.Count > 0 ? candidates[^1] : null;
                if (prev is not null && prev.StopPosition != c.StopPosition
                    && (prev.Name == c.Name || (prev.Position - c.Position).PlanarLength < StopMergeMetres))
                {
                    // A stop position and its platform: one stop at the stop position.
                    prev.Name ??= c.Name;
                    prev.Bay |= c.Bay;
                    if (c.StopPosition)
                    {
                        (prev.OsmId, prev.Position, prev.StopPosition) = (c.OsmId, c.Position, true);
                    }

                    continue;
                }

                candidates.Add(c);
            }

            var stops = new List<TransitStop>();
            var (from, fromPos) = (0, 0.0);
            foreach (var c in candidates)
            {
                (int Index, double Pos, double Distance)? best = null;
                for (var k = from; k < links.Count; k++)
                {
                    var link = links[k];
                    var (pos, lateral) = Project(link.Geometry, c.Position);
                    if (k == from && pos < fromPos)
                    {
                        continue;
                    }

                    var onLink = c.StopPosition && link.OsmNodes.Any(n => n.Id == c.OsmId);
                    var distance = onLink ? 0 : lateral;
                    if (distance <= StopCaptureMetres && (best is null || distance < best.Value.Distance))
                    {
                        best = (k, pos, distance);
                    }
                }

                if (best is not { } b)
                {
                    continue;
                }

                var target = links[b.Index];
                var bay = c.Bay || WayBay(target);
                stops.Add(new TransitStop(
                    $"{lineId}s{stops.Count.ToString(CultureInfo.InvariantCulture)}",
                    c.OsmId,
                    c.Name,
                    target.Id,
                    Math.Round(b.Pos, 2),
                    bay));
                (from, fromPos) = (b.Index, b.Pos);
            }

            return stops;
        }

        private bool WayBay(Link link)
        {
            if (link.OsmWayId is not { } id || !_ways.TryGetValue(id, out var way))
            {
                return false;
            }

            return Tag(way.Tags, "bus_bay") switch
            {
                "both" or "yes" => true,
                "right" => link.OsmForward,
                "left" => !link.OsmForward,
                _ => false,
            };
        }

        /// <summary>Planar distance along <paramref name="points"/> of the nearest point to <paramref name="p"/> and the lateral distance to it.</summary>
        private static (double Along, double Lateral) Project(IReadOnlyList<Vec3> points, Vec3 p)
        {
            var best = (Along: 0.0, Lateral: double.MaxValue);
            var acc = 0.0;
            for (var i = 0; i < points.Count - 1; i++)
            {
                var a = points[i] with { Z = 0 };
                var d = (points[i + 1] - points[i]) with { Z = 0 };
                var len = d.PlanarLength;
                var t = len < 1e-9 ? 0 : Math.Clamp((((p.X - a.X) * d.X) + ((p.Y - a.Y) * d.Y)) / (len * len), 0, 1);
                var lateral = (p with { Z = 0 } - (a + (d * t))).PlanarLength;
                if (lateral < best.Lateral)
                {
                    best = (acc + (t * len), lateral);
                }

                acc += len;
            }

            return best;
        }
    }
}
