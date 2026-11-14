using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Network.Compilation;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Domain.Editing;

/// <summary>A problem with one edit; the edit is skipped (rebase report, #64).</summary>
public sealed record EditIssue(int OperationIndex, string Operation, string Message);

/// <summary>Edited OSM data, lane-graph overrides and the edits that could not be applied.</summary>
public sealed record ChangesetResult(OsmDataSet Data, CompilerOverrides Overrides, IReadOnlyList<EditIssue> Issues);

/// <summary>
/// Applies a changeset to an immutable baseline's OSM data (ADR-0010). Invalid or no longer applicable
/// edits are reported and skipped, so the same changeset can be rebased onto a newer import.
/// </summary>
public static class ChangesetApplier
{
    public const double MinRoundaboutRadius = 6;
    public const double MaxRoundaboutRadius = 60;

    public static ChangesetResult Apply(OsmDataSet baseline, IReadOnlyList<EditOperation> operations)
    {
        ArgumentNullException.ThrowIfNull(baseline);
        ArgumentNullException.ThrowIfNull(operations);
        var state = new State(baseline);
        for (var i = 0; i < operations.Count; i++)
        {
            var op = operations[i];
            var error = op switch
            {
                SetWayTags e => state.SetWayTags(e),
                SetNodeTags e => state.SetNodeTags(e),
                AddWay e => state.AddWay(e),
                InsertNode e => state.InsertNode(e),
                RemoveWay e => state.RemoveWay(e),
                ConvertToRoundabout e => state.ConvertToRoundabout(e),
                SetLaneConnections e => state.SetLaneConnections(e),
                BanMovement e => state.BanMovement(e),
                SetSignalPlan e => state.SetSignalPlan(e),
                _ => "unknown operation",
            };
            if (error is not null)
            {
                state.Issues.Add(new EditIssue(i, op.GetType().Name, error));
            }
        }

        return new ChangesetResult(state.Build(baseline.DataTimestamp), state.Overrides, state.Issues);
    }

    /// <summary>Validates tag values that the compiler depends on; null when valid.</summary>
    public static string? ValidateTag(string key, string? value)
    {
        ArgumentNullException.ThrowIfNull(key);
        if (value is null)
        {
            return null;
        }

        if (key is "lanes" or "lanes:forward" or "lanes:backward" or "lanes:both_ways")
        {
            return int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var n) && n is >= 0 and <= 8
                ? null
                : $"{key} must be an integer between 0 and 8";
        }

        if (key is "maxspeed" or "maxspeed:forward" or "maxspeed:backward")
        {
            return SpeedLimitParser.ParseKmh(value) is > 0 and <= 200 ? null : $"{key} '{value}' is not a valid speed limit";
        }

        if (key == "layer")
        {
            return int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var l) && l is >= -5 and <= 5
                ? null
                : "layer must be an integer between -5 and 5";
        }

        if (key == "highway" && !Network.RoadClasses.TryParse(value, out _) && value is not ("traffic_signals" or "stop" or "give_way" or "mini_roundabout" or "crossing"))
        {
            return $"highway '{value}' is not supported";
        }

        return null;
    }

    private sealed class MutableWay
    {
        public required long Id { get; init; }

        public required long OriginalId { get; init; }

        public required List<long> NodeIds { get; init; }

        public required Dictionary<string, string> Tags { get; init; }
    }

    private sealed class State
    {
        private const long SplitIdBase = -1_000_000_000;
        private readonly Dictionary<long, OsmNode> _nodes;
        private readonly List<MutableWay> _ways;
        private readonly IReadOnlyList<OsmRelation> _relations;
        private long _nextGeneratedId = SplitIdBase;

        public State(OsmDataSet data)
        {
            _nodes = data.Nodes.ToDictionary(kv => kv.Key, kv => kv.Value);
            _ways = data.Ways.Select(w => new MutableWay
            {
                Id = w.Id,
                OriginalId = w.Id,
                NodeIds = w.NodeIds.ToList(),
                Tags = new Dictionary<string, string>(w.Tags, StringComparer.Ordinal),
            }).ToList();
            _relations = data.Relations;
        }

        public CompilerOverrides Overrides { get; } = new();

        public List<EditIssue> Issues { get; } = [];

        public OsmDataSet Build(DateTimeOffset? timestamp)
        {
            var used = _ways.SelectMany(w => w.NodeIds).ToHashSet();
            used.UnionWith(_relations.SelectMany(r => r.Members).Where(m => m.Type == OsmMemberType.Node).Select(m => m.Ref));
            return new OsmDataSet(
                _nodes.Values.Where(n => used.Contains(n.Id)),
                _ways.Select(w => new OsmWay(w.Id, w.NodeIds, w.Tags)),
                timestamp,
                TransitRelations.FollowSplits(_relations, _ways.Select(w => (w.Id, w.OriginalId, (IReadOnlyList<long>)w.NodeIds)).ToList()));
        }

        public string? SetWayTags(SetWayTags e)
        {
            if (e.Tags.Select(t => ValidateTag(t.Key, t.Value)).FirstOrDefault(m => m is not null) is { } invalid)
            {
                return invalid;
            }

            var (way, error) = Isolate(e.WayId, e.FromNode, e.ToNode);
            if (way is null)
            {
                return error;
            }

            Merge(way.Tags, e.Tags);
            return null;
        }

        public string? SetNodeTags(SetNodeTags e)
        {
            if (!_nodes.TryGetValue(e.NodeId, out var node))
            {
                return $"node {e.NodeId} not found";
            }

            if (e.Tags.Select(t => ValidateTag(t.Key, t.Value)).FirstOrDefault(m => m is not null) is { } invalid)
            {
                return invalid;
            }

            var tags = new Dictionary<string, string>(node.Tags, StringComparer.Ordinal);
            Merge(tags, e.Tags);
            _nodes[e.NodeId] = node with { Tags = tags };
            return null;
        }

        public string? AddWay(AddWay e)
        {
            if (e.WayId >= 0 || _ways.Any(w => w.Id == e.WayId))
            {
                return $"new way id {e.WayId} must be negative and unused";
            }

            if (e.Nodes.Count < 2)
            {
                return "a way needs at least two nodes";
            }

            if (!e.Tags.TryGetValue("highway", out var highway) || !Network.RoadClasses.TryParse(highway, out _))
            {
                return "a new way needs a supported highway tag";
            }

            if (e.Tags.Select(t => ValidateTag(t.Key, t.Value)).FirstOrDefault(m => m is not null) is { } invalid)
            {
                return invalid;
            }

            var ids = new List<long>();
            foreach (var n in e.Nodes)
            {
                if (_nodes.ContainsKey(n.Id))
                {
                    ids.Add(n.Id);
                    continue;
                }

                if (n.Id >= 0 || n.Lat is not { } lat || n.Lon is not { } lon || lat is < -90 or > 90 || lon is < -180 or > 180)
                {
                    return $"node {n.Id} does not exist and has no valid position";
                }

                _nodes[n.Id] = new OsmNode(n.Id, new GeoPoint(lat, lon));
                ids.Add(n.Id);
            }

            _ways.Add(new MutableWay { Id = e.WayId, OriginalId = e.WayId, NodeIds = ids, Tags = new Dictionary<string, string>(e.Tags, StringComparer.Ordinal) });
            return null;
        }

        public string? InsertNode(InsertNode e)
        {
            if (e.NodeId >= 0 || _nodes.ContainsKey(e.NodeId))
            {
                return $"new node id {e.NodeId} must be negative and unused";
            }

            var candidates = _ways.Where(w => w.OriginalId == e.WayId || w.Id == e.WayId).ToList();
            foreach (var way in candidates)
            {
                var index = way.NodeIds.IndexOf(e.AfterNode);
                if (index >= 0 && index < way.NodeIds.Count - 1)
                {
                    _nodes[e.NodeId] = new OsmNode(e.NodeId, new GeoPoint(e.Lat, e.Lon));
                    way.NodeIds.Insert(index + 1, e.NodeId);
                    return null;
                }
            }

            return $"way {e.WayId} has no segment after node {e.AfterNode}";
        }

        public string? RemoveWay(RemoveWay e)
        {
            var (way, error) = Isolate(e.WayId, e.FromNode, e.ToNode);
            if (way is null)
            {
                return error;
            }

            _ways.Remove(way);
            return null;
        }

        public string? ConvertToRoundabout(ConvertToRoundabout e)
        {
            if (!_nodes.TryGetValue(e.NodeId, out var centre))
            {
                return $"node {e.NodeId} not found";
            }

            if (e.Radius is < MinRoundaboutRadius or > MaxRoundaboutRadius)
            {
                return $"radius must be between {MinRoundaboutRadius} and {MaxRoundaboutRadius} m";
            }

            var plane = new LocalTangentPlane(centre.Location);
            var ways = _ways.Where(w => w.NodeIds.Contains(e.NodeId)).ToList();
            if (ways.Count == 0)
            {
                return $"node {e.NodeId} is not part of a road";
            }

            var arms = new List<(double Angle, long NodeId, int Rank)>();
            foreach (var way in ways)
            {
                Network.RoadClasses.TryParse(way.Tags.GetValueOrDefault("highway"), out var roadClass);
                var k = way.NodeIds.IndexOf(e.NodeId);
                var before = k > 0 ? CutArm(plane, way.NodeIds.Take(k + 1).Reverse().ToList(), e.Radius) : null;
                var after = k < way.NodeIds.Count - 1 ? CutArm(plane, way.NodeIds.Skip(k).ToList(), e.Radius) : null;
                List<long>? prefix = null;
                var suffix = after is null ? null : new[] { after.Value.NewNode }.Concat(way.NodeIds.Skip(k + after.Value.InsertAfter + 1)).ToList();
                if (before is { } b)
                {
                    prefix = way.NodeIds.Take(k - b.InsertAfter).Append(b.NewNode).ToList();
                    arms.Add((b.Angle, b.NewNode, Network.RoadClasses.Rank(roadClass)));
                }

                if (after is { } a)
                {
                    arms.Add((a.Angle, a.NewNode, Network.RoadClasses.Rank(roadClass)));
                }

                _ways.Remove(way);
                if (prefix is { Count: >= 2 })
                {
                    _ways.Add(new MutableWay { Id = way.Id, OriginalId = way.OriginalId, NodeIds = prefix, Tags = way.Tags });
                }

                if (suffix is { Count: >= 2 })
                {
                    _ways.Add(new MutableWay { Id = prefix is { Count: >= 2 } ? NextId() : way.Id, OriginalId = way.OriginalId, NodeIds = suffix, Tags = new Dictionary<string, string>(way.Tags, StringComparer.Ordinal) });
                }
            }

            if (arms.Count < 2)
            {
                return "a roundabout needs at least two arms";
            }

            // Counter-clockwise ring (right-hand traffic), with intermediate points every ~30°.
            var ordered = arms.OrderBy(a => a.Angle).ToList();
            var ring = new List<long>();
            for (var i = 0; i < ordered.Count; i++)
            {
                ring.Add(ordered[i].NodeId);
                var from = ordered[i].Angle;
                var to = i + 1 < ordered.Count ? ordered[i + 1].Angle : ordered[0].Angle + (2 * Math.PI);
                var steps = (int)Math.Floor((to - from) / (Math.PI / 6));
                for (var s = 1; s < steps; s++)
                {
                    var angle = from + ((to - from) * s / steps);
                    var id = NextId();
                    _nodes[id] = new OsmNode(id, plane.ToGeo(new LocalPoint(e.Radius * Math.Cos(angle), e.Radius * Math.Sin(angle))));
                    ring.Add(id);
                }
            }

            ring.Add(ring[0]);
            var rank = arms.Max(a => a.Rank);
            var highway = rank >= 8 ? "primary" : rank >= 7 ? "secondary" : rank >= 6 ? "tertiary" : "residential";
            _ways.Add(new MutableWay
            {
                Id = NextId(),
                OriginalId = 0,
                NodeIds = ring,
                Tags = new Dictionary<string, string>(StringComparer.Ordinal) { ["highway"] = highway, ["junction"] = "roundabout" },
            });
            return null;
        }

        public string? SetLaneConnections(SetLaneConnections e)
        {
            if (!_nodes.ContainsKey(e.NodeId))
            {
                return $"node {e.NodeId} not found";
            }

            if (e.FromLane < 0 || e.ToLanes.Any(l => l < 0))
            {
                return "lane indices must not be negative";
            }

            var key = new MovementKey(e.NodeId, e.FromNeighbour, e.ToNeighbour);
            if (!Overrides.LaneConnections.TryGetValue(key, out var map))
            {
                Overrides.LaneConnections[key] = map = [];
            }

            map[e.FromLane] = e.ToLanes.Distinct().Order().ToList();
            Overrides.BannedMovements.Remove(key);
            return null;
        }

        public string? BanMovement(BanMovement e)
        {
            if (!_nodes.ContainsKey(e.NodeId))
            {
                return $"node {e.NodeId} not found";
            }

            var key = new MovementKey(e.NodeId, e.FromNeighbour, e.ToNeighbour);
            Overrides.BannedMovements.Add(key);
            Overrides.LaneConnections.Remove(key);
            return null;
        }

        public string? SetSignalPlan(SetSignalPlan e)
        {
            if (!_nodes.ContainsKey(e.NodeId))
            {
                return $"node {e.NodeId} not found";
            }

            if (e.Cycle is < 20 or > 240 || e.PhaseGreen.Count is < 1 or > 6 || e.PhaseGreen.Any(g => g < 3))
            {
                return "cycle must be 20–240 s with 1–6 phases of at least 3 s green";
            }

            Overrides.SignalPlans[e.NodeId] = new SignalPlanOverride(e.Cycle, e.Offset, e.PhaseGreen, e.ApproachPhase ?? new Dictionary<long, int>());
            return null;
        }

        private long NextId() => _nextGeneratedId--;

        private static void Merge(Dictionary<string, string> tags, IReadOnlyDictionary<string, string?> changes)
        {
            foreach (var (key, value) in changes)
            {
                if (value is null)
                {
                    tags.Remove(key);
                }
                else
                {
                    tags[key] = value;
                }
            }
        }

        /// <summary>Splits the way so that the part between the two nodes is a way of its own and returns it.</summary>
        private (MutableWay? Way, string? Error) Isolate(long wayId, long? fromNode, long? toNode)
        {
            var candidates = _ways.Where(w => w.Id == wayId || w.OriginalId == wayId).ToList();
            if (candidates.Count == 0)
            {
                return (null, $"way {wayId} not found");
            }

            if (fromNode is null && toNode is null)
            {
                var whole = candidates.FirstOrDefault(w => w.Id == wayId);
                return whole is null ? (null, $"way {wayId} has been split; give from/to nodes") : (whole, null);
            }

            foreach (var way in candidates)
            {
                var i = fromNode is { } f ? way.NodeIds.IndexOf(f) : 0;
                var j = toNode is { } t ? way.NodeIds.IndexOf(t) : way.NodeIds.Count - 1;
                if (i < 0 || j < 0 || i == j)
                {
                    continue;
                }

                var (start, end) = i < j ? (i, j) : (j, i);
                var current = way;
                if (end < current.NodeIds.Count - 1)
                {
                    var tail = new MutableWay { Id = NextId(), OriginalId = way.OriginalId, NodeIds = current.NodeIds.Skip(end).ToList(), Tags = new Dictionary<string, string>(way.Tags, StringComparer.Ordinal) };
                    current.NodeIds.RemoveRange(end + 1, current.NodeIds.Count - end - 1);
                    _ways.Add(tail);
                }

                if (start > 0)
                {
                    var middle = new MutableWay { Id = NextId(), OriginalId = way.OriginalId, NodeIds = current.NodeIds.Skip(start).ToList(), Tags = new Dictionary<string, string>(way.Tags, StringComparer.Ordinal) };
                    current.NodeIds.RemoveRange(start + 1, current.NodeIds.Count - start - 1);
                    _ways.Add(middle);
                    current = middle;
                }

                return (current, null);
            }

            return (null, $"way {wayId} has no part between nodes {fromNode} and {toNode}");
        }

        /// <summary>
        /// Walks an arm (first node = centre) and inserts a node at <paramref name="radius"/> metres
        /// (or 80 % of a shorter arm). Returns the new node, its angle around the centre and how many
        /// existing arm nodes lie inside the ring.
        /// </summary>
        private (long NewNode, double Angle, int InsertAfter)? CutArm(LocalTangentPlane plane, List<long> arm, double radius)
        {
            var points = arm.Select(id => plane.ToLocal(_nodes[id].Location)).ToList();
            var total = 0.0;
            for (var i = 1; i < points.Count; i++)
            {
                total += Distance(points[i - 1], points[i]);
            }

            var target = Math.Min(radius, total * 0.8);
            if (target <= 0.5)
            {
                return null;
            }

            var acc = 0.0;
            for (var i = 1; i < points.Count; i++)
            {
                var seg = Distance(points[i - 1], points[i]);
                if (acc + seg >= target)
                {
                    var t = (target - acc) / seg;
                    var x = points[i - 1].East + ((points[i].East - points[i - 1].East) * t);
                    var y = points[i - 1].North + ((points[i].North - points[i - 1].North) * t);
                    var id = NextId();
                    _nodes[id] = new OsmNode(id, plane.ToGeo(new LocalPoint(x, y)));
                    return (id, Math.Atan2(y, x), i - 1);
                }

                acc += seg;
            }

            return null;
        }

        private static double Distance(LocalPoint a, LocalPoint b) => Math.Sqrt(Math.Pow(b.East - a.East, 2) + Math.Pow(b.North - a.North, 2));
    }
}
