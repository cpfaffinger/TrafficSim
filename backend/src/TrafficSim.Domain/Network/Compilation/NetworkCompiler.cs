using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Domain.Network.Compilation;

/// <summary>
/// Compiles raw OSM road data into the lane graph (ADR-0009, ADR-0016): ways are split at junctions and
/// clipped to the area, each driving direction becomes a link with lanes, junctions get a control type,
/// connectors and conflict zones, signalised junctions a fixed-time plan.
/// </summary>
public static class NetworkCompiler
{
    public static RoadNetwork Compile(OsmDataSet data, BoundingBox area, CompilerOptions? options = null, CompilerOverrides? overrides = null)
    {
        ArgumentNullException.ThrowIfNull(data);
        ArgumentNullException.ThrowIfNull(area);
        return new Compilation(data, area, options ?? new CompilerOptions(), overrides ?? new CompilerOverrides()).Run();
    }

    private enum Sign
    {
        None,
        GiveWay,
        Stop,
    }

    private sealed record Piece(int Index, OsmWay Way, RoadClass RoadClass, string StartKey, string EndKey, IReadOnlyList<Vec3> Points, IReadOnlyList<long?> NodeIds);

    private sealed class GraphNode
    {
        public required string Key { get; init; }

        public required long? OsmId { get; init; }

        public required Vec3 Position { get; set; }

        public IReadOnlyDictionary<string, string> Tags { get; init; } = OsmTags.Empty;

        public bool Synthetic { get; init; }

        public bool SignalNearby { get; set; }

        public NetworkNode? Node { get; set; }

        public List<Piece> Pieces { get; } = [];

        public List<Link> Incoming { get; } = [];

        public List<Link> Outgoing { get; } = [];

        public double TrimRadius { get; set; }
    }

    private sealed class Compilation(OsmDataSet data, BoundingBox area, CompilerOptions options, CompilerOverrides overrides)
    {
        private readonly Dictionary<Link, (long? Start, long? End)> _neighbours = [];
        private readonly LocalTangentPlane _plane = new(area.Center);
        private readonly Dictionary<string, GraphNode> _nodes = new(StringComparer.Ordinal);
        private readonly Dictionary<string, GraphNode> _byNodeId = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Link> _linkById = new(StringComparer.Ordinal);
        private readonly List<Piece> _pieces = [];
        private readonly Dictionary<Link, Piece> _pieceOf = [];
        private readonly Dictionary<Link, Sign> _approachSigns = [];
        private readonly Dictionary<Link, double> _bothWaysGap = [];
        private readonly List<Link> _links = [];
        private readonly List<Connector> _connectors = [];
        private readonly List<SignalController> _signals = [];
        private (double MinX, double MinY, double MaxX, double MaxY) _rect;

        public RoadNetwork Run()
        {
            var sw = _plane.ToLocal(new GeoPoint(area.South, area.West));
            var ne = _plane.ToLocal(new GeoPoint(area.North, area.East));
            _rect = (sw.East, sw.North, ne.East, ne.North);

            var roadWays = data.Ways
                .Where(w => RoadClasses.TryParse(Tags.Get(w.Tags, "highway"), out _) && Tags.Get(w.Tags, "area") != "yes")
                .OrderBy(w => w.Id)
                .ToList();
            BuildPieces(roadWays);
            AssignNodeIds();
            BuildLinks();
            CaptureSignsAndSignals();
            DecideControls();
            BuildGeometry();
            BuildConnectors();
            BuildConflicts();
            BuildSignalPlans();

            return new RoadNetwork
            {
                Origin = _plane.Origin,
                Area = area,
                OsmTimestamp = data.DataTimestamp,
                Nodes = _nodes.Values.Select(n => n.Node!).OrderBy(n => int.Parse(n.Id.AsSpan(1), System.Globalization.CultureInfo.InvariantCulture)).ToList(),
                Links = _links,
                Connectors = _connectors,
                Signals = _signals,
            };
        }

        // ---------------------------------------------------------------- pieces (split + clip)

        private void BuildPieces(List<OsmWay> ways)
        {
            var uses = new Dictionary<long, int>();
            foreach (var way in ways)
            {
                foreach (var id in way.NodeIds.Distinct())
                {
                    uses[id] = uses.GetValueOrDefault(id) + 1;
                }
            }

            foreach (var way in ways)
            {
                RoadClasses.TryParse(Tags.Get(way.Tags, "highway"), out var roadClass);
                if (AccessRule.ForWay(way.Tags, roadClass).Allowed == VehicleClasses.None)
                {
                    continue;
                }

                var ids = way.NodeIds;
                var points = ids.Select(id => ToLocal(data.Nodes[id])).ToList();
                var cumulative = new double[points.Count];
                for (var i = 1; i < points.Count; i++)
                {
                    cumulative[i] = cumulative[i - 1] + (points[i] - points[i - 1]).PlanarLength;
                }

                var split = new SortedSet<int> { 0, ids.Count - 1 };
                for (var i = 1; i < ids.Count - 1; i++)
                {
                    var tags = data.Nodes[ids[i]].Tags;
                    if (uses[ids[i]] > 1 || Tags.Get(tags, "highway") == "mini_roundabout" || Tags.Get(tags, "railway") == "level_crossing")
                    {
                        split.Add(i);
                    }
                }

                // Mid-block signals (far from any junction) become their own controlled node.
                var structural = split.ToList();
                for (var i = 1; i < ids.Count - 1; i++)
                {
                    if (split.Contains(i) || Tags.Get(data.Nodes[ids[i]].Tags, "highway") != "traffic_signals")
                    {
                        continue;
                    }

                    var nearest = structural.Min(s => Math.Abs(cumulative[s] - cumulative[i]));
                    if (nearest > options.SignalCaptureMetres)
                    {
                        split.Add(i);
                    }
                }

                var cuts = split.ToList();
                for (var c = 1; c < cuts.Count; c++)
                {
                    var range = Enumerable.Range(cuts[c - 1], cuts[c] - cuts[c - 1] + 1).ToList();
                    ClipAndAdd(way, roadClass, range.Select(i => points[i]).ToList(), range.Select(i => (long?)ids[i]).ToList());
                }
            }
        }

        private void ClipAndAdd(OsmWay way, RoadClass roadClass, List<Vec3> points, List<long?> ids)
        {
            var current = new List<Vec3>();
            var currentIds = new List<long?>();
            for (var i = 0; i < points.Count; i++)
            {
                var inside = Inside(points[i]);
                if (i > 0)
                {
                    var wasInside = Inside(points[i - 1]);
                    if (inside != wasInside)
                    {
                        var crossing = ClipPoint(points[i - 1], points[i]);
                        current.Add(crossing);
                        currentIds.Add(null);
                        if (wasInside)
                        {
                            Emit(way, roadClass, current, currentIds);
                            current = [];
                            currentIds = [];
                        }
                    }
                }

                if (inside)
                {
                    current.Add(points[i]);
                    currentIds.Add(ids[i]);
                }
            }

            if (current.Count >= 2)
            {
                Emit(way, roadClass, current, currentIds);
            }
        }

        private void Emit(OsmWay way, RoadClass roadClass, List<Vec3> points, List<long?> ids)
        {
            if (points.Count < 2 || Polyline.PlanarLength(points) < 0.5)
            {
                return;
            }

            var index = _pieces.Count;
            var start = NodeKey(way, index, ids[0], points[0], "s");
            var end = NodeKey(way, index, ids[^1], points[^1], "e");
            if (start == end)
            {
                // A closed way between two identical split nodes: split once more in the middle.
                var mid = points.Count / 2;
                if (mid == 0 || mid == points.Count - 1)
                {
                    return;
                }

                Emit(way, roadClass, points.Take(mid + 1).ToList(), ids.Take(mid + 1).ToList());
                Emit(way, roadClass, points.Skip(mid).ToList(), ids.Skip(mid).ToList());
                return;
            }

            var piece = new Piece(index, way, roadClass, start, end, points, ids);
            _pieces.Add(piece);
            _nodes[start].Pieces.Add(piece);
            _nodes[end].Pieces.Add(piece);
        }

        private string NodeKey(OsmWay way, int pieceIndex, long? osmId, Vec3 position, string suffix)
        {
            if (osmId is { } id)
            {
                var key = $"o{id.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
                if (!_nodes.ContainsKey(key))
                {
                    _nodes[key] = new GraphNode { Key = key, OsmId = id, Position = position, Tags = data.Nodes[id].Tags };
                }

                return key;
            }

            var synthetic = string.Create(System.Globalization.CultureInfo.InvariantCulture, $"b{way.Id}_{pieceIndex}_{suffix}");
            _nodes[synthetic] = new GraphNode { Key = synthetic, OsmId = null, Position = position, Synthetic = true };
            return synthetic;
        }

        private bool Inside(Vec3 p) => p.X >= _rect.MinX && p.X <= _rect.MaxX && p.Y >= _rect.MinY && p.Y <= _rect.MaxY;

        private Vec3 ClipPoint(Vec3 a, Vec3 b)
        {
            var t = 1.0;
            void Edge(double pa, double pb, double bound)
            {
                if ((pa - bound) * (pb - bound) < 0)
                {
                    t = Math.Min(t, (bound - pa) / (pb - pa));
                }
            }

            // a is inside or b is inside; parametrise from the inside point.
            var (from, to) = Inside(a) ? (a, b) : (b, a);
            Edge(from.X, to.X, _rect.MinX);
            Edge(from.X, to.X, _rect.MaxX);
            Edge(from.Y, to.Y, _rect.MinY);
            Edge(from.Y, to.Y, _rect.MaxY);
            return from + ((to - from) * t);
        }

        private Vec3 ToLocal(OsmNode node)
        {
            var p = _plane.ToLocal(node.Location);
            return new Vec3(p.East, p.North);
        }

        private void AssignNodeIds()
        {
            var ordered = _nodes.Values
                .Where(n => n.Pieces.Count > 0)
                .OrderBy(n => n.Synthetic)
                .ThenBy(n => n.OsmId ?? 0)
                .ThenBy(n => n.Key, StringComparer.Ordinal)
                .ToList();
            foreach (var key in _nodes.Keys.Where(k => _nodes[k].Pieces.Count == 0).ToList())
            {
                _nodes.Remove(key);
            }

            for (var i = 0; i < ordered.Count; i++)
            {
                ordered[i].Node = new NetworkNode
                {
                    Id = $"n{i.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
                    OsmId = ordered[i].OsmId,
                    Position = ordered[i].Position,
                    Control = ordered[i].Synthetic ? NodeControl.Boundary : NodeControl.None,
                };
                _byNodeId[ordered[i].Node!.Id] = ordered[i];
            }
        }

        // ---------------------------------------------------------------- links and lanes

        private void BuildLinks()
        {
            foreach (var piece in _pieces)
            {
                var tags = piece.Way.Tags;
                var layout = LaneLayoutRule.Resolve(tags, piece.RoadClass);
                Link? forward = null;
                Link? backward = null;
                if (layout.OneWay != OneWay.Backward)
                {
                    forward = CreateLink(piece, layout, TravelDirection.Forward);
                }

                if (layout.OneWay != OneWay.Forward)
                {
                    backward = CreateLink(piece, layout, TravelDirection.Backward);
                }

                if (forward is not null && backward is not null)
                {
                    forward.OppositeLinkId = backward.Id;
                    backward.OppositeLinkId = forward.Id;
                }
            }
        }

        private Link CreateLink(Piece piece, LaneLayout layout, TravelDirection direction)
        {
            var tags = piece.Way.Tags;
            var id = $"l{_links.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
            var n = layout.For(direction);
            var assumed = new SortedSet<string>(StringComparer.Ordinal);
            if (layout.Assumed)
            {
                assumed.Add("lanes");
            }

            var (speed, speedAssumed) = SpeedLimitParser.ForWay(tags, piece.RoadClass, direction);
            if (speedAssumed)
            {
                assumed.Add("speedLimit");
            }

            var (wayAllowed, through) = AccessRule.ForWay(tags, piece.RoadClass);
            var turns = Tags.GetLanes(tags, "turn", direction, layout.OneWay, n);
            var speeds = Tags.GetLanes(tags, "maxspeed", direction, layout.OneWay, n);
            var bus = Tags.GetLanes(tags, "bus", direction, layout.OneWay, n) ?? Tags.GetLanes(tags, "psv", direction, layout.OneWay, n);
            var hgv = Tags.GetLanes(tags, "hgv", direction, layout.OneWay, n);
            var access = Tags.GetLanes(tags, "motor_vehicle", direction, layout.OneWay, n) ?? Tags.GetLanes(tags, "access", direction, layout.OneWay, n);
            var widths = Tags.GetLanes(tags, "width", direction, layout.OneWay, n);
            var change = Tags.GetLanes(tags, "change", direction, layout.OneWay, n);

            var defaultWidth = RoadClasses.DefaultLaneWidth(piece.RoadClass);
            var totalLanes = layout.Forward + layout.Backward + layout.BothWays;
            var widthPerLane = ParseDouble(Tags.Get(tags, "width")) is { } w && w / totalLanes is var pl && pl is >= 2.2 and <= 5 ? pl : (double?)null;
            if (widths is null && widthPerLane is null)
            {
                assumed.Add("width");
            }

            var lanes = Enumerable.Range(0, n).Select(i => new Lane
            {
                LinkId = id,
                Index = i,
                Width = ParseDouble(widths?[i]) is { } lw and >= 1.5 and <= 6 ? lw : widthPerLane ?? defaultWidth,
                SpeedLimit = SpeedLimitParser.ParseKmh(speeds?[i]) is { } ls and > 0 ? ls * SpeedLimitParser.KmhToMs : speed,
                Allowed = AccessRule.ForLane(wayAllowed, bus?[i], hgv?[i], access?[i]),
                Turns = TurnLanesParser.ParseLane(turns?[i]),
            }).ToList();

            var (layer, structure) = GradeSeparationRule.Parse(tags);
            var link = new Link
            {
                Id = id,
                OsmWayId = piece.Way.Id,
                From = _nodes[direction == TravelDirection.Forward ? piece.StartKey : piece.EndKey].Node!.Id,
                To = _nodes[direction == TravelDirection.Forward ? piece.EndKey : piece.StartKey].Node!.Id,
                RoadClass = piece.RoadClass,
                Name = Tags.Get(tags, "name") ?? Tags.Get(tags, "ref"),
                Layer = layer,
                Structure = structure,
                Roundabout = Tags.Get(tags, "junction") is "roundabout" or "circular",
                ThroughTraffic = through,
                SpeedLimit = speed,
                Geometry = direction == TravelDirection.Forward ? piece.Points : Polyline.Reverse(piece.Points),
                Lanes = lanes,
                Boundaries = LaneChangeRule.Boundaries(change, Tags.GetDirectional(tags, "change", direction), n),
                LeftEdge = LaneChangeRule.LeftEdge(tags, layout.OneWay, direction, layout.Forward, layout.Backward),
                Assumed = assumed,
            };
            _links.Add(link);
            _linkById[id] = link;
            _pieceOf[link] = piece;
            _bothWaysGap[link] = layout.OneWay == OneWay.No ? layout.BothWays * defaultWidth / 2 : -1;
            _neighbours[link] = direction == TravelDirection.Forward
                ? (piece.NodeIds[1], piece.NodeIds[^2])
                : (piece.NodeIds[^2], piece.NodeIds[1]);
            var startKey = direction == TravelDirection.Forward ? piece.StartKey : piece.EndKey;
            var endKey = direction == TravelDirection.Forward ? piece.EndKey : piece.StartKey;
            _nodes[startKey].Outgoing.Add(link);
            _nodes[endKey].Incoming.Add(link);
            return link;
        }

        private static double? ParseDouble(string? value) =>
            double.TryParse(value?.Replace(" m", string.Empty, StringComparison.Ordinal), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var d) && d > 0 ? d : null;

        // ---------------------------------------------------------------- junction control

        private GraphNode NodeByKey(string key) => _nodes[key];

        private void CaptureSignsAndSignals()
        {
            foreach (var piece in _pieces)
            {
                var cumulative = 0.0;
                var total = Polyline.PlanarLength(piece.Points);
                for (var i = 0; i < piece.Points.Count; i++)
                {
                    if (i > 0)
                    {
                        cumulative += (piece.Points[i] - piece.Points[i - 1]).PlanarLength;
                    }

                    if (i == 0 || i == piece.Points.Count - 1 || piece.NodeIds[i] is not { } osmId)
                    {
                        continue;
                    }

                    var tags = data.Nodes[osmId].Tags;
                    var highway = Tags.Get(tags, "highway");
                    var toStart = cumulative;
                    var toEnd = total - cumulative;
                    if (highway == "traffic_signals")
                    {
                        if (toEnd <= options.SignalCaptureMetres)
                        {
                            NodeByKey(piece.EndKey).SignalNearby = true;
                        }

                        if (toStart <= options.SignalCaptureMetres)
                        {
                            NodeByKey(piece.StartKey).SignalNearby = true;
                        }
                    }
                    else if (highway is "stop" or "give_way")
                    {
                        var sign = highway == "stop" ? Sign.Stop : Sign.GiveWay;
                        var dir = Tags.Get(tags, "direction");
                        var towardsEnd = dir switch
                        {
                            "forward" => true,
                            "backward" => false,
                            _ => toEnd <= toStart,
                        };
                        var distance = towardsEnd ? toEnd : toStart;
                        if (distance > options.SignCaptureMetres)
                        {
                            continue;
                        }

                        var target = towardsEnd ? piece.EndKey : piece.StartKey;
                        foreach (var link in NodeByKey(target).Incoming.Where(l => _pieceOf[l] == piece))
                        {
                            _approachSigns[link] = sign;
                        }
                    }
                }
            }
        }

        private void DecideControls()
        {
            foreach (var g in _nodes.Values)
            {
                var node = g.Node!;
                if (node.Control == NodeControl.Boundary)
                {
                    continue;
                }

                var tags = g.Tags;
                var highway = Tags.Get(tags, "highway");
                var degree = g.Pieces.Count;
                var ring = g.Pieces.Count(p => IsRoundabout(p));
                if (highway == "traffic_signals" || g.SignalNearby)
                {
                    node.Control = NodeControl.Signal;
                }
                else if (highway == "mini_roundabout" || (ring > 0 && ring < degree))
                {
                    node.Control = NodeControl.Roundabout;
                }
                else if (Tags.Get(tags, "railway") == "level_crossing")
                {
                    node.Control = NodeControl.LevelCrossing;
                }
                else if (degree <= 2)
                {
                    node.Control = NodeControl.None;
                }
                else if (highway == "stop" && Tags.Get(tags, "stop") == "all")
                {
                    node.Control = NodeControl.AllWayStop;
                }
                else if (g.Pieces.All(p => RoadClasses.IsMinorStreet(p.RoadClass))
                         && highway is not ("stop" or "give_way")
                         && g.Incoming.All(l => _approachSigns.GetValueOrDefault(l) == Sign.None))
                {
                    node.Control = NodeControl.RightBeforeLeft;
                }
                else
                {
                    node.Control = NodeControl.Priority;
                }
            }
        }

        private static bool IsRoundabout(Piece p) => Tags.Get(p.Way.Tags, "junction") is "roundabout" or "circular";

        // ---------------------------------------------------------------- geometry

        private void BuildGeometry()
        {
            // Node levels and elevations (grade separation, ADR-0016).
            foreach (var g in _nodes.Values)
            {
                var level = GradeSeparationRule.NodeLevel(g.Pieces.Select(p => GradeSeparationRule.Parse(p.Way.Tags).Layer));
                g.Position = g.Position.WithZ(GradeSeparationRule.Elevation(level));
                g.Node!.Position = g.Position;
                var junction = (g.Node.Control is not (NodeControl.None or NodeControl.Boundary or NodeControl.LevelCrossing) && g.Pieces.Count >= 3)
                               || g.Node.Control == NodeControl.Roundabout;
                g.TrimRadius = junction
                    ? Math.Clamp(g.Incoming.Concat(g.Outgoing).Max(l => RoadHalfWidth(l)) + 1.0, 3, 20)
                    : 0;
            }

            foreach (var link in _links)
            {
                var from = _byNodeId[link.From];
                var to = _byNodeId[link.To];
                var layerZ = GradeSeparationRule.Elevation(link.Layer);
                var full = GradeSeparationRule.Apply(link.Geometry, from.Position.Z, to.Position.Z, layerZ);
                var length = Polyline.PlanarLength(full);
                var rs = from.TrimRadius;
                var re = to.TrimRadius;
                if (rs + re > length - 1)
                {
                    var scale = Math.Max(0, (length - 1) / Math.Max(rs + re, 1e-9));
                    rs *= scale;
                    re *= scale;
                }

                var trimmed = rs > 0 || re > 0 ? Polyline.Slice(full, rs, length - re) : full;
                link.Geometry = trimmed;

                var gap = _bothWaysGap[link];
                var leftEdge = gap >= 0 ? gap : -link.TotalWidth / 2;
                var leftOf = 0.0;
                foreach (var lane in link.Lanes.OrderByDescending(l => l.Index))
                {
                    var offset = leftEdge + leftOf + (lane.Width / 2);
                    lane.Geometry = Polyline.Offset(trimmed, offset);
                    leftOf += lane.Width;
                }

                if (to.Node!.Control == NodeControl.Signal && link.Lanes.Count > 1)
                {
                    link.NoLaneChangeZone = Math.Min(options.SolidApproachMetres, link.Length * 0.5);
                    link.Assumed.Add("noLaneChangeZone");
                }
            }
        }

        private double RoadHalfWidth(Link link)
        {
            var opposite = link.OppositeLinkId is { } o ? _linkById[o] : null;
            var gap = Math.Max(0, _bothWaysGap[link]) * 2;
            return opposite is null ? link.TotalWidth / 2 : (link.TotalWidth + opposite.TotalWidth + gap) / 2;
        }

        // ---------------------------------------------------------------- connectors

        private void BuildConnectors()
        {
            foreach (var g in _nodes.Values.OrderBy(n => n.Node!.Id.Length).ThenBy(n => n.Node!.Id, StringComparer.Ordinal))
            {
                var node = g.Node!;
                if (node.Control == NodeControl.Boundary)
                {
                    continue;
                }

                var majorPieces = node.Control == NodeControl.Priority ? MajorPieces(g) : [];
                foreach (var incoming in g.Incoming)
                {
                    var candidates = g.Outgoing.Where(o => o.Id != incoming.OppositeLinkId).ToList();
                    if (candidates.Count == 0)
                    {
                        candidates = g.Outgoing.ToList(); // dead end: allow turning around
                    }

                    var allowedIn = incoming.Lanes.Aggregate(VehicleClasses.None, (a, l) => a | l.Allowed);
                    var movements = candidates
                        .Where(o => (o.Lanes.Aggregate(VehicleClasses.None, (a, l) => a | l.Allowed) & allowedIn) != VehicleClasses.None)
                        .Select(o => (Out: o, Angle: Polyline.SignedAngle(Polyline.Direction(incoming.Geometry, atEnd: true), Polyline.Direction(o.Geometry, atEnd: false))))
                        .OrderByDescending(m => m.Angle)
                        .ToList();
                    foreach (var (outgoing, angle) in movements)
                    {
                        var turn = TurnLanesParser.Classify(angle);
                        var key = g.OsmId is { } osm && _neighbours[incoming].End is { } from && _neighbours[outgoing].Start is { } to
                            ? new MovementKey(osm, from, to)
                            : (MovementKey?)null;
                        if (key is { } banned && overrides.BannedMovements.Contains(banned))
                        {
                            continue;
                        }

                        var pairs = key is { } k && overrides.LaneConnections.TryGetValue(k, out var map)
                            ? map.Where(kv => kv.Key < incoming.Lanes.Count)
                                .SelectMany(kv => kv.Value.Where(t => t < outgoing.Lanes.Count).Select(t => (kv.Key, t)))
                            : MapLanes(incoming, outgoing, turn, movements.Count);
                        foreach (var (fromLane, toLane) in pairs.ToList())
                        {
                            AddConnector(g, incoming, fromLane, outgoing, toLane, turn, majorPieces);
                        }
                    }
                }
            }
        }

        private IEnumerable<(int From, int To)> MapLanes(Link incoming, Link outgoing, Turn turn, int movementCount)
        {
            var n = incoming.Lanes.Count;
            var m = outgoing.Lanes.Count;
            IReadOnlyList<int> sources = [];
            if (incoming.Lanes.Any(l => l.Turns != TurnMarkings.None))
            {
                foreach (var compatible in TurnLanesParser.Compatible(turn))
                {
                    sources = incoming.Lanes.Where(l => (l.Turns & compatible) != 0).Select(l => l.Index).ToList();
                    if (sources.Count > 0)
                    {
                        break;
                    }
                }
            }

            if (sources.Count == 0)
            {
                sources = movementCount <= 1 || turn == Turn.Through || n == 1
                    ? Enumerable.Range(0, n).ToList()
                    : TurnLanesParser.IsRightish(turn) ? [0] : TurnLanesParser.IsLeftish(turn) ? [n - 1] : Enumerable.Range(0, n).ToList();
            }

            var k = sources.Count;
            for (var j = 0; j < k; j++)
            {
                if (TurnLanesParser.IsLeftish(turn) && movementCount > 1)
                {
                    // align from the left
                    var fromLeft = k - 1 - j;
                    yield return (sources[j], Math.Max(0, m - 1 - Math.Min(fromLeft, m - 1)));
                }
                else
                {
                    yield return (sources[j], Math.Min(j, m - 1));
                }
            }

            // Added lanes on the left are fed by the leftmost source lane (through movements).
            if (!TurnLanesParser.IsLeftish(turn) && !TurnLanesParser.IsRightish(turn) && m > k)
            {
                for (var t = k; t < m; t++)
                {
                    yield return (sources[k - 1], t);
                }
            }
        }

        private void AddConnector(GraphNode g, Link incoming, int fromLane, Link outgoing, int toLane, Turn turn, HashSet<Piece> majorPieces)
        {
            var a = incoming.Lanes[fromLane].Geometry;
            var b = outgoing.Lanes[toLane].Geometry;
            var start = a[^1];
            var end = b[0];
            var geometry = (end - start).PlanarLength < 0.5
                ? new List<Vec3> { start, end }
                : Polyline.Bezier(start, Polyline.Direction(a, atEnd: true, span: 3), end, Polyline.Direction(b, atEnd: false, span: 3));
            var priority = g.Node!.Control switch
            {
                NodeControl.Signal => ConnectorPriority.Signal,
                NodeControl.Roundabout => incoming.Roundabout ? ConnectorPriority.RoundaboutRing : ConnectorPriority.RoundaboutEntry,
                NodeControl.RightBeforeLeft => ConnectorPriority.RightBeforeLeft,
                NodeControl.AllWayStop or NodeControl.LevelCrossing => ConnectorPriority.Stop,
                NodeControl.Priority => _approachSigns.GetValueOrDefault(incoming) == Sign.Stop
                    ? ConnectorPriority.Stop
                    : majorPieces.Contains(_pieceOf[incoming]) && !TurnLanesParser.IsLeftish(turn)
                        ? ConnectorPriority.Major
                        : ConnectorPriority.Minor,
                _ => ConnectorPriority.Major,
            };
            _connectors.Add(new Connector
            {
                Id = $"c{_connectors.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
                NodeId = g.Node.Id,
                FromLink = incoming.Id,
                FromLane = fromLane,
                ToLink = outgoing.Id,
                ToLane = toLane,
                Turn = turn,
                Priority = priority,
                Geometry = geometry,
            });
        }

        /// <summary>The (up to two) pieces forming the priority road through a junction.</summary>
        private HashSet<Piece> MajorPieces(GraphNode g)
        {
            var unsigned = g.Pieces
                .Where(p => !g.Incoming.Any(l => _pieceOf[l] == p && _approachSigns.GetValueOrDefault(l) != Sign.None))
                .ToList();
            if (unsigned.Count == 0)
            {
                return [];
            }

            var first = unsigned.OrderByDescending(p => RoadClasses.Rank(p.RoadClass)).ThenBy(p => p.Index).First();
            var firstDir = OutwardDirection(g, first);
            var second = unsigned.Where(p => p != first)
                .OrderByDescending(p => RoadClasses.Rank(p.RoadClass))
                .ThenByDescending(p => Math.Abs(Polyline.SignedAngle(firstDir, OutwardDirection(g, p))))
                .FirstOrDefault();
            var explicitMinor = Tags.Get(g.Tags, "highway") is "stop" or "give_way";
            if (explicitMinor && second is not null && RoadClasses.Rank(second.RoadClass) < RoadClasses.Rank(first.RoadClass))
            {
                second = null;
            }

            return second is null ? [first] : [first, second];
        }

        private static Vec3 OutwardDirection(GraphNode g, Piece p)
        {
            var points = p.StartKey == g.Key ? p.Points : Polyline.Reverse(p.Points);
            return Polyline.Direction(points, atEnd: false);
        }

        private void BuildConflicts()
        {
            foreach (var group in _connectors.GroupBy(c => c.NodeId))
            {
                var list = group.ToList();
                for (var i = 0; i < list.Count; i++)
                {
                    for (var j = i + 1; j < list.Count; j++)
                    {
                        var a = list[i];
                        var b = list[j];
                        if (a.FromLink == b.FromLink && a.FromLane == b.FromLane)
                        {
                            continue; // diverging from the same lane
                        }

                        if ((a.ToLink == b.ToLink && a.ToLane == b.ToLane) || Polyline.Crosses(a.Geometry, b.Geometry))
                        {
                            a.Conflicts.Add(b.Id);
                            b.Conflicts.Add(a.Id);
                        }
                    }
                }
            }
        }

        // ---------------------------------------------------------------- signal plans

        private void BuildSignalPlans()
        {
            var byNode = _connectors.ToLookup(c => c.NodeId, StringComparer.Ordinal);
            foreach (var g in _nodes.Values.Where(n => n.Node!.Control == NodeControl.Signal).OrderBy(n => n.Node!.Id, StringComparer.Ordinal))
            {
                var node = g.Node!;
                var approaches = g.Incoming.Where(l => byNode[node.Id].Any(c => c.FromLink == l.Id)).ToList();
                if (approaches.Count == 0)
                {
                    continue;
                }

                var axis = Polyline.Direction(approaches[0].Geometry, atEnd: true);
                var groupOf = approaches.ToDictionary(l => l.Id, l =>
                {
                    var angle = Math.Abs(Polyline.SignedAngle(axis, Polyline.Direction(l.Geometry, atEnd: true)));
                    return angle <= 45 || angle >= 135 ? 0 : 1;
                });

                var cycle = options.SignalCycleSeconds;
                var groups = new List<SignalGroup>();
                var used = groupOf.Values.Distinct().Order().ToList();
                if (g.OsmId is { } osmId && overrides.SignalPlans.TryGetValue(osmId, out var plan))
                {
                    cycle = plan.Cycle;
                    var start = 0.0;
                    for (var p = 0; p < plan.PhaseGreen.Count; p++)
                    {
                        groups.Add(new SignalGroup($"{node.Id}:g{p.ToString(System.Globalization.CultureInfo.InvariantCulture)}", [new GreenInterval(start, Math.Min(cycle, start + plan.PhaseGreen[p]))], options.AmberSeconds));
                        start += plan.PhaseGreen[p] + options.AmberSeconds + options.AllRedSeconds;
                    }

                    foreach (var approach in approaches)
                    {
                        groupOf[approach.Id] = _neighbours[approach].End is { } n && plan.ApproachPhase.TryGetValue(n, out var phase)
                            ? Math.Clamp(phase, 0, plan.PhaseGreen.Count - 1)
                            : Math.Min(groupOf[approach.Id], plan.PhaseGreen.Count - 1);
                    }
                }
                else if (used.Count == 1)
                {
                    groups.Add(new SignalGroup($"{node.Id}:g0", [new GreenInterval(0, cycle * 2 / 3)], options.AmberSeconds));
                    foreach (var key in groupOf.Keys)
                    {
                        groupOf[key] = 0;
                    }
                }
                else
                {
                    var phase = (cycle - (2 * (options.AmberSeconds + options.AllRedSeconds))) / 2;
                    var secondStart = phase + options.AmberSeconds + options.AllRedSeconds;
                    groups.Add(new SignalGroup($"{node.Id}:g0", [new GreenInterval(0, phase)], options.AmberSeconds));
                    groups.Add(new SignalGroup($"{node.Id}:g1", [new GreenInterval(secondStart, secondStart + phase)], options.AmberSeconds));
                }

                foreach (var c in byNode[node.Id])
                {
                    c.SignalGroup = $"{node.Id}:g{groupOf.GetValueOrDefault(c.FromLink).ToString(System.Globalization.CultureInfo.InvariantCulture)}";
                }

                var offset = g.OsmId is { } oid && overrides.SignalPlans.TryGetValue(oid, out var p2) ? p2.Offset : 0;
                _signals.Add(new SignalController(node.Id, cycle, offset, groups));
            }
        }
    }
}
