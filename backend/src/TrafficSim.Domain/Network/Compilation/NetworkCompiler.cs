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
        ArgumentNullException.ThrowIfNull(area);
        return Compile(data, GeoPolygon.FromBoundingBox(area), options, overrides);
    }

    /// <summary>Compiles the roads inside <paramref name="area"/>; ways are clipped at its edge (#110).</summary>
    public static RoadNetwork Compile(OsmDataSet data, GeoPolygon area, CompilerOptions? options = null, CompilerOverrides? overrides = null)
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

        /// <summary>Dead end where a road dropped by the road selection continued (#131): a boundary.</summary>
        public bool Cut { get; set; }

        public bool SignalNearby { get; set; }

        public NetworkNode? Node { get; set; }

        public List<Piece> Pieces { get; } = [];

        public List<Link> Incoming { get; } = [];

        public List<Link> Outgoing { get; } = [];

        public double TrimRadius { get; set; }
    }

    private sealed class Compilation(OsmDataSet data, GeoPolygon polygon, CompilerOptions options, CompilerOverrides overrides)
    {
        private readonly Dictionary<Link, (long? Start, long? End)> _neighbours = [];
        private readonly BoundingBox area = polygon.Bounds;
        private readonly LocalTangentPlane _plane = new(polygon.Bounds.Center);
        private List<Vec3> _clip = [];
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
        private int _ignoredSigns;


        public RoadNetwork Run()
        {
            _clip = polygon.Ring.Select(p => _plane.ToLocal(p)).Select(p => new Vec3(p.East, p.North)).ToList();

            var allRoads = data.Ways
                .Where(w => RoadClasses.TryParse(Tags.Get(w.Tags, "highway"), out _) && Tags.Get(w.Tags, "area") != "yes")
                .OrderBy(w => w.Id)
                .ToList();
            var roadWays = allRoads.Where(w => Selected(w)).ToList();
            BuildPieces(roadWays);
            MarkCuts(allRoads.Where(w => !Selected(w)));
            PruneStubs();
            AssignNodeIds();
            BuildLinks();
            CaptureSignsAndSignals();
            DecideControls();
            BuildGeometry();
            BuildConnectors();
            BuildConflicts();
            BuildSignalPlans();
            AssignEndSigns();
            var nodes = _nodes.Values.Select(n => n.Node!).OrderBy(n => int.Parse(n.Id.AsSpan(1), System.Globalization.CultureInfo.InvariantCulture)).ToList();
            var crossings = CrossingRule.Build(data, nodes, _links, _connectors, _signals);

            var network = new RoadNetwork
            {
                Origin = _plane.Origin,
                Area = area,
                Polygon = polygon.IsRectangle ? null : polygon,
                OsmTimestamp = data.DataTimestamp,
                Nodes = nodes,
                Links = _links,
                Connectors = _connectors,
                Signals = _signals,
                IgnoredSigns = _ignoredSigns,
                Terrain = options.Terrain,
                Crossings = crossings,
            };
            TransitRule.Apply(network, data);
            return network;
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
                    if (split.Contains(i) || (Tags.Get(data.Nodes[ids[i]].Tags, "highway") != "traffic_signals" && !CrossingRule.IsSignalisedCrossing(data.Nodes[ids[i]].Tags)))
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

        /// <summary>
        /// Clips a way piece to the area polygon segment by segment: every crossing with the polygon edge
        /// splits a segment, so segments passing through the area without an inner vertex are kept too.
        /// </summary>
        private void ClipAndAdd(OsmWay way, RoadClass roadClass, List<Vec3> points, List<long?> ids)
        {
            var current = new List<Vec3>();
            var currentIds = new List<long?>();
            for (var i = 0; i < points.Count - 1; i++)
            {
                var a = points[i];
                var b = points[i + 1];
                var ts = Crossings(a, b);
                for (var k = 0; k < ts.Count - 1; k++)
                {
                    var (t0, t1) = (ts[k], ts[k + 1]);
                    if (t1 - t0 < 1e-9)
                    {
                        continue;
                    }

                    if (Inside(a + ((b - a) * ((t0 + t1) / 2))))
                    {
                        if (current.Count == 0)
                        {
                            current.Add(t0 == 0 ? a : a + ((b - a) * t0));
                            currentIds.Add(t0 == 0 ? ids[i] : null);
                        }

                        current.Add(t1 == 1 ? b : a + ((b - a) * t1));
                        currentIds.Add(t1 == 1 ? ids[i + 1] : null);
                    }
                    else if (current.Count > 0)
                    {
                        Emit(way, roadClass, current, currentIds);
                        current = [];
                        currentIds = [];
                    }
                }
            }

            if (current.Count >= 2)
            {
                Emit(way, roadClass, current, currentIds);
            }
        }

        /// <summary>Sorted segment parameters 0, crossings with the polygon edge, 1.</summary>
        private List<double> Crossings(Vec3 from, Vec3 to)
        {
            var result = new List<double> { 0, 1 };
            for (int i = 0, j = _clip.Count - 1; i < _clip.Count; j = i++)
            {
                var p = _clip[j];
                var q = _clip[i];
                var d = ((to.X - from.X) * (q.Y - p.Y)) - ((to.Y - from.Y) * (q.X - p.X));
                if (Math.Abs(d) < 1e-12)
                {
                    continue;
                }

                var t = (((p.X - from.X) * (q.Y - p.Y)) - ((p.Y - from.Y) * (q.X - p.X))) / d;
                var u = (((p.X - from.X) * (to.Y - from.Y)) - ((p.Y - from.Y) * (to.X - from.X))) / d;
                if (t > 0 && t < 1 && u >= 0 && u <= 1)
                {
                    result.Add(t);
                }
            }

            result.Sort();
            return result;
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

        private bool Selected(OsmWay way)
        {
            if (options.Roads == RoadSelection.All)
            {
                return true;
            }

            RoadClasses.TryParse(Tags.Get(way.Tags, "highway"), out var c);
            return c is RoadClass.Motorway or RoadClass.MotorwayLink or RoadClass.Trunk or RoadClass.TrunkLink
                || (options.Roads == RoadSelection.Major && c is RoadClass.Primary or RoadClass.PrimaryLink);
        }

        /// <summary>
        /// Where a dropped road (#131) met a kept one that ends there, e.g. a ramp leading into the local
        /// network, the end is a network boundary: traffic enters and leaves there instead of turning.
        /// </summary>
        private void MarkCuts(IEnumerable<OsmWay> dropped)
        {
            var nodes = dropped.SelectMany(w => w.NodeIds).ToHashSet();
            foreach (var g in _nodes.Values.Where(g => g.OsmId is { } id && nodes.Contains(id) && g.Pieces.Count == 1))
            {
                g.Cut = true;
            }
        }

        /// <summary>
        /// Drops short dead-end stubs of minor roads (#127): OSM often maps the first metres of a driveway or
        /// parking entrance as a service road whose rest is not a road we import. Such a stub leads nowhere,
        /// yet makes its node a junction with turning traffic. Repeated, so chains of stubs go too; longer
        /// dead ends (cul-de-sacs) and major roads stay.
        /// </summary>
        private void PruneStubs()
        {
            var minor = new HashSet<RoadClass> { RoadClass.Service, RoadClass.Residential, RoadClass.LivingStreet, RoadClass.Unclassified, RoadClass.Road };
            bool removed;
            do
            {
                removed = false;
                foreach (var piece in _pieces.ToList())
                {
                    if (!minor.Contains(piece.RoadClass) || Polyline.PlanarLength(piece.Points) >= options.StubMetres)
                    {
                        continue;
                    }

                    var (start, end) = (_nodes[piece.StartKey], _nodes[piece.EndKey]);
                    bool DeadEnd(GraphNode n) => !n.Synthetic && !n.Cut && n.Pieces.Count == 1;
                    if ((DeadEnd(start) && end.Pieces.Count > 1) || (DeadEnd(end) && start.Pieces.Count > 1))
                    {
                        _pieces.Remove(piece);
                        start.Pieces.Remove(piece);
                        end.Pieces.Remove(piece);
                        removed = true;
                    }
                }
            }
            while (removed);

            foreach (var key in _nodes.Where(kv => kv.Value.Pieces.Count == 0).Select(kv => kv.Key).ToList())
            {
                _nodes.Remove(key);
            }
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

        private bool Inside(Vec3 p)
        {
            var inside = false;
            for (int i = 0, j = _clip.Count - 1; i < _clip.Count; j = i++)
            {
                var (a, b) = (_clip[i], _clip[j]);
                if ((a.Y > p.Y) != (b.Y > p.Y) && p.X < ((b.X - a.X) * (p.Y - a.Y) / (b.Y - a.Y)) + a.X)
                {
                    inside = !inside;
                }
            }

            return inside;
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
                    Control = ordered[i].Synthetic || ordered[i].Cut ? NodeControl.Boundary : NodeControl.None,
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
                Limits = VehicleLimitParser.ForWay(tags, direction),
            };
            _links.Add(link);
            _linkById[id] = link;
            _pieceOf[link] = piece;
            _bothWaysGap[link] = layout.OneWay == OneWay.No ? layout.BothWays * defaultWidth / 2 : -1;
            _neighbours[link] = direction == TravelDirection.Forward
                ? (piece.NodeIds[1], piece.NodeIds[^2])
                : (piece.NodeIds[^2], piece.NodeIds[1]);
            link.OsmAfterFrom = _neighbours[link].Start;
            link.OsmForward = direction == TravelDirection.Forward;
            var nodes = piece.NodeIds.Zip(piece.Points, (id, p) => new OsmNodeRef(id, p)).ToList();
            link.OsmNodes = direction == TravelDirection.Forward ? nodes : Enumerable.Reverse(nodes).ToList();
            link.OsmBeforeTo = _neighbours[link].End;
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
                    var signs = SignRule.NodeSigns(tags);
                    if (highway == "traffic_signals")
                    {
                        if (toEnd <= options.SignalCaptureMetres && !SignalsSuppressed(NodeByKey(piece.EndKey)))
                        {
                            NodeByKey(piece.EndKey).SignalNearby = true;
                        }

                        if (toStart <= options.SignalCaptureMetres && !SignalsSuppressed(NodeByKey(piece.StartKey)))
                        {
                            NodeByKey(piece.StartKey).SignalNearby = true;
                        }
                    }
                    else if ((signs & (SignKinds.Stop | SignKinds.GiveWay)) != 0)
                    {
                        var sign = (signs & SignKinds.Stop) != 0 ? Sign.Stop : Sign.GiveWay;
                        var towardsEnd = SignRule.Direction(tags) ?? (toEnd <= toStart);
                        if (!AttachSign(piece, towardsEnd, towardsEnd ? toEnd : toStart, sign))
                        {
                            _ignoredSigns++;
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Attaches a stop/give-way sign to the approach of the next junction in travel direction, following
        /// the road across plain joints (#102). False when no junction lies within the capture distance.
        /// </summary>
        private bool AttachSign(Piece piece, bool towardsEnd, double distance, Sign sign)
        {
            var current = piece;
            var forward = towardsEnd;
            for (var hops = 0; hops < 20 && distance <= options.SignCaptureMetres; hops++)
            {
                var target = NodeByKey(forward ? current.EndKey : current.StartKey);
                if (target.Pieces.Count >= 3 || target.Node!.Control == NodeControl.Boundary || target.Pieces.Count == 1)
                {
                    if (target.Pieces.Count < 3)
                    {
                        return false;
                    }

                    var piece2 = current;
                    foreach (var link in target.Incoming.Where(l => _pieceOf[l] == piece2))
                    {
                        _approachSigns[link] = sign;
                    }

                    return true;
                }

                var next = target.Pieces.First(p => p != current);
                forward = next.StartKey == target.Key;
                distance += Polyline.PlanarLength(next.Points);
                current = next;
            }

            return false;
        }

        private static bool SignalsSuppressed(GraphNode g) => Tags.Get(g.Tags, "trafficsim:signals") == "no";

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
                var nodeSigns = SignRule.NodeSigns(tags);
                var priorityRoad = g.Pieces.Any(p => SignRule.IsPriorityRoad(p.Way.Tags));
                if (((highway == "traffic_signals" || (degree <= 2 && CrossingRule.IsSignalisedCrossing(tags))) && !SignalsSuppressed(g)) || g.SignalNearby)
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
                else if ((nodeSigns & SignKinds.Stop) != 0 && Tags.Get(tags, "stop") == "all")
                {
                    node.Control = NodeControl.AllWayStop;
                }
                else if (g.Pieces.All(p => RoadClasses.IsMinorStreet(p.RoadClass))
                         && (nodeSigns & (SignKinds.Stop | SignKinds.GiveWay)) == 0
                         && !priorityRoad
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
                g.Position = g.Position.WithZ(GradeSeparationRule.Elevation(level) + ElevationRule.Ground(options.Terrain, g.Position));
                g.Node!.Position = g.Position;
                var junction = (g.Node.Control is not (NodeControl.None or NodeControl.Boundary or NodeControl.LevelCrossing) && g.Pieces.Count >= 3)
                               || g.Node.Control == NodeControl.Roundabout;
                g.TrimRadius = junction
                    ? Math.Clamp(g.Incoming.Concat(g.Outgoing).Max(l => RoadHalfWidth(l)) + 1.0, 3, 20)
                    : 0;
            }

            LimitTightRoundabouts();
            var trims = EndTrims();
            foreach (var link in _links)
            {
                var from = _byNodeId[link.From];
                var to = _byNodeId[link.To];
                var layerZ = GradeSeparationRule.Elevation(link.Layer);
                // Terrain under the grade-separation profile (ADR-0018); identical to ADR-0016 without terrain.
                var full = ElevationRule.Apply(
                    link.Geometry,
                    from.Position.Z - ElevationRule.Ground(options.Terrain, from.Position),
                    to.Position.Z - ElevationRule.Ground(options.Terrain, to.Position),
                    layerZ,
                    options.Terrain,
                    ElevationRule.FollowsTerrain(link.Structure, link.Layer));
                var length = Polyline.PlanarLength(full);
                var rs = trims.GetValueOrDefault((link, true), from.TrimRadius);
                var re = trims.GetValueOrDefault((link, false), to.TrimRadius);
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

        /// <summary>
        /// Rings of small roundabouts (centre line under <see cref="CompilerOptions.TightRoundaboutMetres"/>,
        /// about 22 m across) are too tight for articulated trucks (RVS 03.05.14: at least ~26 m outer
        /// diameter): they get an assumed length limit unless the way has one (#125). Runs on the
        /// untrimmed geometry.
        /// </summary>
        private void LimitTightRoundabouts()
        {
            var ring = _links.Where(l => l.Roundabout).ToList();
            var parent = ring.SelectMany(l => new[] { l.From, l.To }).Distinct().ToDictionary(n => n, n => n);
            string Find(string n) => parent[n] == n ? n : parent[n] = Find(parent[n]);
            foreach (var l in ring)
            {
                parent[Find(l.From)] = Find(l.To);
            }

            foreach (var group in ring.GroupBy(l => Find(l.From)))
            {
                // A two-way ring piece counts once.
                var circumference = group
                    .Where(l => l.OppositeLinkId is null || string.CompareOrdinal(l.Id, l.OppositeLinkId) < 0)
                    .Sum(l => Polyline.PlanarLength(l.Geometry));
                if (circumference >= options.TightRoundaboutMetres)
                {
                    continue;
                }

                foreach (var l in group.Where(l => l.Limits?.MaxLength is null))
                {
                    l.Limits = (l.Limits ?? new VehicleLimits()) with { MaxLength = options.TightRoundaboutMaxLength };
                    l.Assumed.Add("maxLength");
                }
            }
        }

        /// <summary>
        /// How far each road end is cut back at a junction (#123): at least the node's radius, and for
        /// every other road leaving at an acute angle, far enough that this road starts outside the
        /// other's footprint and beyond its corner. Otherwise a road branching off at 45° starts inside
        /// a wide approach, and turning into it means going back.
        /// </summary>
        private Dictionary<(Link Link, bool AtStart), double> EndTrims()
        {
            const double minAngle = 15 * Math.PI / 180; // nearly parallel: the same arm (carriageways)
            const double maxTrim = 25;
            const double margin = 0.5;
            var trims = new Dictionary<(Link, bool), double>();
            foreach (var g in _nodes.Values.Where(n => n.TrimRadius > 0))
            {
                // Directions pointing away from the node, with the road's width left and right of them.
                var ends = g.Outgoing.Select(l => (Link: l, AtStart: true, Dir: Polyline.Direction(l.Geometry, atEnd: false).PlanarNormalized()))
                    .Concat(g.Incoming.Select(l => (Link: l, AtStart: false, Dir: (Polyline.Direction(l.Geometry, atEnd: true) * -1).PlanarNormalized())))
                    .Select(e => (e.Link, e.AtStart, e.Dir, Extent: ArmExtent(e.Link, e.AtStart)))
                    .ToList();
                var pairs = new List<(int Self, int Other, double Cos, double Sin, double OtherWidth, double SelfWidth)>();
                for (var i = 0; i < ends.Count; i++)
                {
                    for (var j = 0; j < ends.Count; j++)
                    {
                        var (a, b) = (ends[i], ends[j]);
                        if (i == j || b.Link.Id == a.Link.OppositeLinkId)
                        {
                            continue;
                        }

                        var cos = Math.Clamp((a.Dir.X * b.Dir.X) + (a.Dir.Y * b.Dir.Y), -1, 1);
                        var angle = Math.Acos(cos);
                        if (angle is < minAngle or >= Math.PI / 2)
                        {
                            continue;
                        }

                        // Is `a` to the left of `b`? Then b's left side faces a, and a's right side faces b.
                        var aLeftOfB = (b.Dir.X * a.Dir.Y) - (b.Dir.Y * a.Dir.X) > 0;
                        pairs.Add((i, j, cos, Math.Sin(angle), aLeftOfB ? b.Extent.Left : b.Extent.Right, aLeftOfB ? a.Extent.Right : a.Extent.Left));
                    }
                }

                // Pass 1: this road's near edge leaves the other road's strip.
                var trim = ends.Select(_ => g.TrimRadius).ToArray();
                foreach (var (self, _, cos, sin, otherWidth, selfWidth) in pairs)
                {
                    trim[self] = Math.Max(trim[self], (otherWidth + margin + (selfWidth * cos)) / sin);
                }

                // Pass 2: ... and starts beyond the other road's corner (its cut-back end at its near edge).
                var first = trim.ToArray();
                foreach (var (self, other, cos, sin, otherWidth, _) in pairs)
                {
                    trim[self] = Math.Max(trim[self], (first[other] * cos) + (otherWidth * sin) + margin);
                }

                for (var i = 0; i < ends.Count; i++)
                {
                    trims[(ends[i].Link, ends[i].AtStart)] = Math.Min(trim[i], maxTrim);
                }
            }

            return trims;
        }

        /// <summary>
        /// Width of a road arm left and right of the direction pointing away from the node: its lanes
        /// lie right of the travel direction, from the gap to the centre line (or centred when one-way).
        /// </summary>
        private (double Left, double Right) ArmExtent(Link link, bool outgoing)
        {
            double LeftEdge(Link l) => _bothWaysGap[l] >= 0 ? _bothWaysGap[l] : -l.TotalWidth / 2;
            var travelRight = LeftEdge(link) + link.TotalWidth;
            var travelLeft = link.OppositeLinkId is { } o && _linkById[o] is var opposite
                ? LeftEdge(opposite) + opposite.TotalWidth
                : -LeftEdge(link);
            return outgoing ? (travelLeft, travelRight) : (travelRight, travelLeft);
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
                var merge = MergeLanes(g);
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
                    // #123: no turning back where the road goes on (e.g. a two-way road splitting into
                    // carriageways), unless an arrow allows it.
                    if (movements.Any(m => TurnLanesParser.Classify(m.Angle) != Turn.Reverse)
                        && !incoming.Lanes.Any(l => (l.Turns & TurnMarkings.Reverse) != 0))
                    {
                        movements = movements.Where(m => TurnLanesParser.Classify(m.Angle) != Turn.Reverse).ToList();
                    }

                    var forks = ForkMarkings(movements.Select(m => TurnLanesParser.Classify(m.Angle)).ToList());
                    var forkLanes = ForkLanes(incoming, movements.Select(m => TurnLanesParser.Classify(m.Angle)).ToList());
                    var planned = new List<(Link Out, Turn Turn, List<(int From, int To)> Pairs)>();
                    var custom = false;
                    for (var i = 0; i < movements.Count; i++)
                    {
                        var outgoing = movements[i].Out;
                        var turn = TurnLanesParser.Classify(movements[i].Angle);
                        var key = g.OsmId is { } osm && _neighbours[incoming].End is { } from && _neighbours[outgoing].Start is { } to
                            ? new MovementKey(osm, from, to)
                            : (MovementKey?)null;
                        if (key is { } banned && overrides.BannedMovements.Contains(banned))
                        {
                            custom = true;
                            continue;
                        }

                        IEnumerable<(int From, int To)> pairs;
                        if (key is { } k && overrides.LaneConnections.TryGetValue(k, out var map))
                        {
                            custom = true;
                            pairs = map.Where(kv => kv.Key < incoming.Lanes.Count)
                                .SelectMany(kv => kv.Value.Where(t => t < outgoing.Lanes.Count).Select(t => (kv.Key, t)));
                        }
                        else
                        {
                            pairs = CoverClasses(incoming, outgoing, (merge?.GetValueOrDefault(incoming) ?? MapLanes(incoming, outgoing, turn, forks[i], movements.Count, forkLanes?[i])).ToList());
                        }

                        planned.Add((outgoing, turn, pairs.ToList()));
                    }

                    if (!custom)
                    {
                        ConnectDeadLanes(incoming, planned);
                    }

                    foreach (var (outgoing, turn, pairs) in planned)
                    {
                        foreach (var (fromLane, toLane) in pairs)
                        {
                            AddConnector(g, incoming, fromLane, outgoing, toLane, turn, majorPieces);
                        }
                    }
                }
            }
        }

        /// <summary>
        /// Source lanes per movement where a marked road forks into branches that all run nearly straight
        /// (motorway exits, #134), or null: lanes ordered by the direction of their arrow (left … through or
        /// unmarked … right) go to the branches in their order left to right, one arrow direction per branch
        /// when the counts match; with two branches, the right one takes the lanes with right arrows.
        /// </summary>
        private static List<IReadOnlyList<int>>? ForkLanes(Link incoming, List<Turn> turns)
        {
            if (turns.Count < 2 || turns.Any(t => t != Turn.Through) || incoming.Lanes.All(l => l.Turns == TurnMarkings.None))
            {
                return null;
            }

            static int Score(TurnMarkings t) =>
                (t & (TurnMarkings.SharpRight | TurnMarkings.Right)) != 0 ? 2
                : (t & TurnMarkings.SlightRight) != 0 && (t & TurnMarkings.Through) == 0 ? 1
                : (t & (TurnMarkings.SharpLeft | TurnMarkings.Left)) != 0 ? -2
                : (t & TurnMarkings.SlightLeft) != 0 && (t & TurnMarkings.Through) == 0 ? -1
                : 0;

            var score = incoming.Lanes.Select(l => Score(l.Turns)).ToList();
            var distinct = score.Distinct().Order().ToList();
            // Movements are ordered left to right; their source lanes, by score group.
            var groups = new List<IReadOnlyList<int>>();
            if (distinct.Count == turns.Count)
            {
                groups.AddRange(distinct.Select(d => (IReadOnlyList<int>)Enumerable.Range(0, score.Count).Where(k => score[k] == d).ToList()));
            }
            else if (turns.Count == 2 && score.Any(s => s > 0) && score.Any(s => s <= 0))
            {
                groups.Add(Enumerable.Range(0, score.Count).Where(k => score[k] <= 0).ToList());
                groups.Add(Enumerable.Range(0, score.Count).Where(k => score[k] > 0).ToList());
            }
            else
            {
                return null;
            }

            return groups;
        }

        /// <summary>
        /// Lane permissions along a movement (#133): a source lane whose vehicle classes cannot use any of its
        /// target lanes (one became a bus lane) also gets the nearest target lane that allows them, so its
        /// cars do not end up on a lane without a way on.
        /// </summary>
        private static List<(int From, int To)> CoverClasses(Link incoming, Link outgoing, List<(int From, int To)> pairs)
        {
            foreach (var from in pairs.Select(p => p.From).Distinct().ToList())
            {
                var targets = pairs.Where(p => p.From == from).Select(p => p.To).ToList();
                var covered = targets.Aggregate(VehicleClasses.None, (a, t) => a | outgoing.Lanes[t].Allowed);
                var missing = incoming.Lanes[from].Allowed & ~covered;
                if (missing == VehicleClasses.None)
                {
                    continue;
                }

                var near = targets.Average();
                var extra = outgoing.Lanes
                    .Where(l => (l.Allowed & missing) != VehicleClasses.None && !targets.Contains(l.Index))
                    .OrderBy(l => Math.Abs(l.Index - near))
                    .ThenBy(l => l.Index)
                    .Select(l => (int?)l.Index)
                    .FirstOrDefault();
                if (extra is { } t)
                {
                    pairs.Add((from, t));
                }
            }

            return pairs;
        }

        /// <summary>
        /// The turn arrows to match per movement (ordered left to right). Where a road forks into several
        /// movements within the "through" angle, the leftmost branch takes slight-left arrows and the
        /// rightmost slight-right ones (#118: B3 exits in Krems).
        /// </summary>
        private static List<Turn> ForkMarkings(List<Turn> turns)
        {
            var result = turns.ToList();
            var through = Enumerable.Range(0, turns.Count).Where(i => turns[i] == Turn.Through).ToList();
            if (through.Count >= 2)
            {
                result[through[0]] = Turn.SlightLeft;
                result[through[^1]] = Turn.SlightRight;
            }

            return result;
        }

        /// <summary>
        /// Every lane must lead somewhere (#118): a lane the arrows left without a movement continues like its
        /// nearest neighbour lane (the rightmost of the neighbour's movements for a lane to its right, the
        /// leftmost for one to its left) onto the adjacent target lane.
        /// </summary>
        private static void ConnectDeadLanes(Link incoming, List<(Link Out, Turn Turn, List<(int From, int To)> Pairs)> planned)
        {
            var served = planned.SelectMany(p => p.Pairs.Select(x => x.From)).ToHashSet();
            if (served.Count == 0)
            {
                return;
            }

            foreach (var lane in Enumerable.Range(0, incoming.Lanes.Count).Where(l => !served.Contains(l)))
            {
                var neighbour = served.OrderBy(s => Math.Abs(s - lane)).ThenBy(s => s).First();
                var right = lane < neighbour;
                var options = planned.Where(p => p.Pairs.Any(x => x.From == neighbour)).ToList();
                var (outgoing, _, pairs) = right ? options[^1] : options[0];
                var targets = pairs.Where(x => x.From == neighbour).Select(x => x.To).ToList();
                var to = Math.Clamp((right ? targets.Min() : targets.Max()) + lane - neighbour, 0, outgoing.Lanes.Count - 1);
                pairs.Add((lane, to));
            }
        }

        private IEnumerable<(int From, int To)> MapLanes(Link incoming, Link outgoing, Turn turn, Turn marking, int movementCount, IReadOnlyList<int>? forkSources = null)
        {
            var n = incoming.Lanes.Count;
            var m = outgoing.Lanes.Count;
            IReadOnlyList<int> sources = forkSources ?? [];

            // With a single way on, the arrows belong to a junction further ahead (the way is split before
            // it): every lane continues (#118).
            if (sources.Count == 0 && movementCount > 1 && incoming.Lanes.Any(l => l.Turns != TurnMarkings.None))
            {
                foreach (var compatible in TurnLanesParser.Compatible(marking))
                {
                    sources = incoming.Lanes.Where(l => (l.Turns & compatible) != 0).Select(l => l.Index).ToList();
                    if (sources.Count > 0)
                    {
                        break;
                    }
                }

                // Unmarked lanes between or next to the lanes of a straight movement belong to it (#134: A23,
                // through|none|none|through|slight_right; the two unmarked lanes were attached afterwards and
                // crossed the others), up to the next lane marked for something else.
                if (sources.Count > 0 && turn == Turn.Through && sources.Any(k => (incoming.Lanes[k].Turns & TurnMarkings.Through) != 0))
                {
                    var set = sources.ToHashSet();
                    for (var u = sources.Min(); u <= sources.Max(); u++)
                    {
                        if (incoming.Lanes[u].Turns == TurnMarkings.None)
                        {
                            set.Add(u);
                        }
                    }

                    for (var u = sources.Min() - 1; u >= 0 && incoming.Lanes[u].Turns == TurnMarkings.None; u--)
                    {
                        set.Add(u);
                    }

                    for (var u = sources.Max() + 1; u < n && incoming.Lanes[u].Turns == TurnMarkings.None; u++)
                    {
                        set.Add(u);
                    }

                    sources = set.Order().ToList();
                }

                // No arrow fits: lanes without arrows take the movement, as on unmarked roads below.
                var unmarked = incoming.Lanes.Where(l => l.Turns == TurnMarkings.None).Select(l => l.Index).ToList();
                if (sources.Count == 0 && unmarked.Count > 0)
                {
                    sources = turn == Turn.Through || unmarked.Count == 1 ? unmarked
                        : TurnLanesParser.IsRightish(turn) ? [unmarked[0]]
                        : TurnLanesParser.IsLeftish(turn) ? [unmarked[^1]]
                        : unmarked;
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

        /// <summary>
        /// Lane mapping where several roads merge into one (motorway on-ramps, #81): the main road keeps the
        /// lanes counted from the left, roads joining from the right map onto the rightmost lanes.
        /// Returns null when the node is not a pure merge.
        /// </summary>
        private Dictionary<Link, IEnumerable<(int From, int To)>>? MergeLanes(GraphNode g)
        {
            if (g.Incoming.Count < 2 || g.Node!.Control is NodeControl.Signal or NodeControl.Roundabout)
            {
                return null;
            }

            var targets = g.Incoming.Select(i => g.Outgoing.Where(o => o.Id != i.OppositeLinkId).ToList()).ToList();
            if (targets.Any(t => t.Count != 1) || targets.Select(t => t[0]).Distinct().Count() != 1)
            {
                return null;
            }

            var outgoing = targets[0][0];
            var outDir = Polyline.Direction(outgoing.Geometry, atEnd: false);
            var main = g.Incoming
                .OrderByDescending(l => RoadClasses.Rank(l.RoadClass))
                .ThenBy(l => Math.Abs(Polyline.SignedAngle(Polyline.Direction(l.Geometry, atEnd: true), outDir)))
                .First();
            var mainAngle = Polyline.SignedAngle(Polyline.Direction(main.Geometry, atEnd: true), outDir);
            var m = outgoing.Lanes.Count;
            var result = new Dictionary<Link, IEnumerable<(int From, int To)>>();
            foreach (var incoming in g.Incoming)
            {
                var n = incoming.Lanes.Count;
                var angle = Polyline.SignedAngle(Polyline.Direction(incoming.Geometry, atEnd: true), outDir);
                // A road that must turn right (clockwise) to join comes from the right-hand side.
                var fromRight = incoming != main && angle < mainAngle;
                result[incoming] = Enumerable.Range(0, n)
                    .Select(i => fromRight || (incoming != main && n >= m) ? (i, Math.Min(i, m - 1)) : (i, Math.Max(0, m - n + i)))
                    .ToList();
            }

            return result;
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

            static int Rank(Piece p) => SignRule.Rank(p.RoadClass, SignRule.IsPriorityRoad(p.Way.Tags));
            var first = unsigned.OrderByDescending(Rank).ThenBy(p => p.Index).First();
            var firstDir = OutwardDirection(g, first);
            var second = unsigned.Where(p => p != first)
                .OrderByDescending(Rank)
                .ThenByDescending(p => Math.Abs(Polyline.SignedAngle(firstDir, OutwardDirection(g, p))))
                .FirstOrDefault();
            var explicitMinor = (SignRule.NodeSigns(g.Tags) & (SignKinds.Stop | SignKinds.GiveWay)) != 0;
            if (explicitMinor && second is not null && Rank(second) < Rank(first))
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

        /// <summary>The sign governing each link's approach to its end node, for rendering and inspection (#104).</summary>
        private void AssignEndSigns()
        {
            var byLink = _connectors.ToLookup(c => c.FromLink, StringComparer.Ordinal);
            foreach (var link in _links)
            {
                var end = _byNodeId[link.To];
                var connectors = byLink[link.Id].ToList();
                link.EndSign = end.Node!.Control switch
                {
                    NodeControl.AllWayStop or NodeControl.LevelCrossing => EndSign.Stop,
                    NodeControl.Roundabout when !link.Roundabout => EndSign.GiveWay,
                    NodeControl.Priority when _approachSigns.GetValueOrDefault(link) == Sign.Stop || connectors.Any(c => c.Priority == ConnectorPriority.Stop) => EndSign.Stop,
                    NodeControl.Priority when _approachSigns.GetValueOrDefault(link) == Sign.GiveWay => EndSign.GiveWay,
                    NodeControl.Priority when connectors.Count > 0 && connectors.All(c => c.Priority == ConnectorPriority.Minor) => EndSign.GiveWay,
                    NodeControl.Priority when SignRule.IsPriorityRoad(_pieceOf[link].Way.Tags) => EndSign.PriorityRoad,
                    _ => EndSign.None,
                };
            }
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

        /// <summary>
        /// Fixed-time plans, one controller per signal node. Signal nodes linked by short roads form one junction
        /// (#117: OSM has a signal node on each carriageway of a dual carriageway): they share the phase axis, so a
        /// movement passing several of them is green at all of them, and the movements out of links too short to
        /// wait on are green whenever a movement into them is.
        /// </summary>
        private void BuildSignalPlans()
        {
            var byNode = _connectors.ToLookup(c => c.NodeId, StringComparer.Ordinal);
            var signalNodes = _nodes.Values.Where(n => n.Node!.Control == NodeControl.Signal).OrderBy(n => n.Node!.Id, StringComparer.Ordinal).ToList();
            var cluster = SignalClusters(signalNodes);
            var internalLink = (Link l) => cluster.TryGetValue(l.From, out var a) && cluster.TryGetValue(l.To, out var b) && a == b
                && l.Length <= options.SignalClusterMetres;
            var axes = new Dictionary<string, Vec3>(StringComparer.Ordinal);
            var groupOfLink = new Dictionary<string, int>(StringComparer.Ordinal);
            var plans = new List<(GraphNode G, double Cycle, List<SignalGroup> Groups, Dictionary<string, int> GroupOf)>();
            foreach (var g in signalNodes)
            {
                var node = g.Node!;
                var approaches = g.Incoming.Where(l => byNode[node.Id].Any(c => c.FromLink == l.Id)).ToList();
                if (approaches.Count == 0)
                {
                    continue;
                }

                var root = cluster[node.Id];
                var clustered = signalNodes.Count(n => cluster[n.Node!.Id] == root) > 1;
                if (!axes.TryGetValue(root, out var axis))
                {
                    var reference = approaches.FirstOrDefault(l => !internalLink(l)) ?? approaches[0];
                    axis = Polyline.Direction(reference.Geometry, atEnd: true);
                    axes[root] = axis;
                }

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
                else if (used.Count == 1 && !clustered)
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

                foreach (var (link, group) in groupOf)
                {
                    groupOfLink[link] = group;
                }

                plans.Add((g, cycle, groups, groupOf));
            }

            // Movements out of short links inside a junction follow the movements into them (#117): one phase, or
            // a group that is always green when the link is fed in both phases.
            const int always = -1;
            // Feeders are found back through further short links and nodes without signals (#126: B3 Krems,
            // signal → 1 m → priority node → 1 m → signal).
            List<int> FeederGroups(Link link, string root, int depth)
            {
                var result = new List<int>();
                foreach (var c in _connectors.Where(c => c.ToLink == link.Id))
                {
                    var from = _linkById[c.FromLink];
                    if (cluster.TryGetValue(link.From, out var r) && r == root && groupOfLink.TryGetValue(from.Id, out var group))
                    {
                        result.Add(group);
                    }
                    else if (depth > 0 && !cluster.ContainsKey(link.From) && from.Length < options.SignalChainMetres)
                    {
                        result.AddRange(FeederGroups(from, root, depth - 1));
                    }
                }

                return result.Distinct().ToList();
            }

            for (var pass = 0; pass < 3; pass++)
            {
                foreach (var (g, _, _, groupOf) in plans)
                {
                    var root = cluster[g.Node!.Id];
                    foreach (var link in g.Incoming.Where(l => groupOf.ContainsKey(l.Id) && l.Length < options.SignalChainMetres))
                    {
                        var feeders = FeederGroups(link, root, 3);
                        if (feeders.Count > 0)
                        {
                            groupOf[link.Id] = groupOfLink[link.Id] = feeders.Count == 1 ? feeders[0] : always;
                        }
                    }
                }
            }

            foreach (var (g, cycle, groups, groupOf) in plans)
            {
                var node = g.Node!;
                if (groupOf.ContainsValue(always))
                {
                    groups.Add(new SignalGroup($"{node.Id}:ga", [new GreenInterval(0, cycle)], options.AmberSeconds));
                }

                foreach (var c in byNode[node.Id])
                {
                    var group = groupOf.GetValueOrDefault(c.FromLink);
                    c.SignalGroup = group == always ? $"{node.Id}:ga" : $"{node.Id}:g{group.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
                }

                var offset = g.OsmId is { } oid && overrides.SignalPlans.TryGetValue(oid, out var p2) ? p2.Offset : 0;
                _signals.Add(new SignalController(node.Id, cycle, offset, groups));
            }
        }

        /// <summary>
        /// Signal node id → id of the first node of its cluster: nodes linked by roads up to
        /// <see cref="CompilerOptions.SignalClusterMetres"/>, also through nodes without signals in between
        /// (#126), as long as the whole connection stays that short.
        /// </summary>
        private Dictionary<string, string> SignalClusters(List<GraphNode> signalNodes)
        {
            var parent = signalNodes.ToDictionary(n => n.Node!.Id, n => n.Node!.Id, StringComparer.Ordinal);
            string Find(string id) => parent[id] == id ? id : parent[id] = Find(parent[id]);
            void Union(string x, string y)
            {
                var (a, b) = (Find(x), Find(y));
                if (a != b)
                {
                    // The smaller id is the root, so the cluster's reference node does not depend on link order.
                    (a, b) = string.CompareOrdinal(a, b) < 0 ? (a, b) : (b, a);
                    parent[b] = a;
                }
            }

            foreach (var g in signalNodes)
            {
                var start = g.Node!.Id;
                var queue = new Queue<(GraphNode Node, double Distance)>([(g, 0)]);
                var seen = new HashSet<string>(StringComparer.Ordinal) { start };
                while (queue.Count > 0)
                {
                    var (node, distance) = queue.Dequeue();
                    foreach (var link in node.Outgoing.Where(l => distance + l.Length <= options.SignalClusterMetres))
                    {
                        if (!seen.Add(link.To))
                        {
                            continue;
                        }

                        var next = _byNodeId[link.To];
                        if (parent.ContainsKey(link.To))
                        {
                            Union(start, link.To);
                        }
                        else if (next.Node!.Control != NodeControl.Boundary)
                        {
                            queue.Enqueue((next, distance + link.Length));
                        }
                    }
                }
            }

            return signalNodes.ToDictionary(n => n.Node!.Id, n => Find(n.Node!.Id), StringComparer.Ordinal);
        }
    }
}
