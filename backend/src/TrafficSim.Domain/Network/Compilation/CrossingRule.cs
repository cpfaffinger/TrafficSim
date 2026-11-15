using TrafficSim.Domain.Osm;

namespace TrafficSim.Domain.Network.Compilation;

/// <summary>
/// Pedestrian crossings (ADR-0020, #86): <c>highway=crossing</c> nodes (and crossing-tagged
/// <c>highway=traffic_signals</c> nodes) on drivable ways, nodes shared with <c>footway=crossing</c> ways
/// as a fallback, and implicit crosswalks on the legs of signalised junctions and at mid-block signals.
/// Each crossing is attached to the directional links it crosses with the position of its centre and
/// the lateral span of each link's lanes along the crossing.
/// </summary>
public static class CrossingRule
{
    /// <summary>Mapped crossings this close (m, along the link) to a signal node belong to it.</summary>
    public const double SignalReachMetres = 40;

    /// <summary>A mapped crossing this close (m) to a junction replaces the implicit crosswalk of its leg.</summary>
    public const double ImplicitReplaceMetres = 30;

    /// <summary>Extent along the road (m) of signalised crosswalks and of other crossings.</summary>
    public const double SignalDepth = 4;

    /// <summary>
    /// Legs shorter than this towards another junction node lie inside one junction (dual carriageways,
    /// slip roads): no implicit crosswalk there (#126), pedestrians cross on the outer legs.
    /// </summary>
    public const double InnerLegMetres = 20;

    public const double OtherDepth = 3;

    /// <summary>Kind of a crossing node, null when the node is no (usable) crossing.</summary>
    public static CrossingKind? ClassifyNode(IReadOnlyDictionary<string, string> tags)
    {
        ArgumentNullException.ThrowIfNull(tags);
        var highway = Tags.Get(tags, "highway");
        var crossing = Tags.Get(tags, "crossing");
        if (crossing == "no")
        {
            return null;
        }

        return highway switch
        {
            "crossing" => Kind(tags),
            // Pedestrian signals mapped on the signal node itself.
            "traffic_signals" when crossing is not null => CrossingKind.Signal,
            _ => null,
        };
    }

    /// <summary>Kind of a <c>footway=crossing</c> (or <c>path=crossing</c>) way, null for other ways.</summary>
    public static CrossingKind? ClassifyWay(IReadOnlyDictionary<string, string> tags)
    {
        ArgumentNullException.ThrowIfNull(tags);
        if (Tags.Get(tags, "footway") != "crossing" && Tags.Get(tags, "path") != "crossing")
        {
            return null;
        }

        return Tags.Get(tags, "crossing") == "no" ? null : Kind(tags);
    }

    /// <summary>A <c>highway=crossing</c> node with a pedestrian signal (becomes a mid-block signal node).</summary>
    public static bool IsSignalisedCrossing(IReadOnlyDictionary<string, string> tags) =>
        Tags.Get(tags, "highway") == "crossing" && ClassifyNode(tags) == CrossingKind.Signal;

    private static CrossingKind Kind(IReadOnlyDictionary<string, string> tags)
    {
        var crossing = Tags.Get(tags, "crossing");
        var markings = Tags.Get(tags, "crossing:markings");
        if (crossing == "traffic_signals" || Tags.IsYes(Tags.Get(tags, "crossing:signals")))
        {
            return CrossingKind.Signal;
        }

        if (crossing == "zebra" || Tags.Get(tags, "crossing_ref") == "zebra" || (markings?.StartsWith("zebra", StringComparison.Ordinal) ?? false))
        {
            return CrossingKind.Zebra;
        }

        return crossing switch
        {
            "uncontrolled" or "marked" => CrossingKind.Uncontrolled,
            _ when markings is not null && markings != "no" => CrossingKind.Uncontrolled,
            _ => CrossingKind.Unmarked,
        };
    }

    /// <summary>
    /// Assumed pedestrians per hour (both directions) without land-use data: busier on main roads, lower at
    /// unmarked crossings and implicit crosswalks. The scenario generator refines it with the activity
    /// density around the crossing (ADR-0020).
    /// </summary>
    public static double BaseDemand(RoadClass roadClass, CrossingKind kind, bool isImplicit)
    {
        double road = roadClass switch
        {
            RoadClass.Motorway or RoadClass.MotorwayLink => 0,
            RoadClass.Trunk or RoadClass.TrunkLink => 80,
            RoadClass.Primary or RoadClass.PrimaryLink or RoadClass.Secondary or RoadClass.SecondaryLink => 120,
            RoadClass.Tertiary or RoadClass.TertiaryLink => 90,
            RoadClass.Unclassified or RoadClass.Road or RoadClass.Busway => 50,
            RoadClass.Residential => 40,
            RoadClass.LivingStreet => 30,
            _ => 20,
        };
        var factor = kind switch
        {
            CrossingKind.Uncontrolled => 0.6,
            CrossingKind.Unmarked => 0.4,
            _ => 1.0,
        };
        return road * factor * (isImplicit ? 0.75 : 1);
    }

    private sealed record Entry(Link Link, double Position);

    private sealed record Candidate(long? OsmId, CrossingKind Kind, List<Entry> Entries, bool Implicit, NetworkNode? SignalNode, string? Group, CrossingSignalMode Mode);

    /// <summary>Crossings of a compiled network (links with final geometry, connectors with signal groups).</summary>
    internal static IReadOnlyList<Crossing> Build(
        OsmDataSet data,
        IReadOnlyList<NetworkNode> nodes,
        IReadOnlyList<Link> links,
        IReadOnlyList<Connector> connectors,
        IReadOnlyList<SignalController> signals)
    {
        var ctx = new Context(nodes, links, connectors, signals);
        var footway = new Dictionary<long, CrossingKind>();
        foreach (var way in data.Ways.OrderBy(w => w.Id))
        {
            if (ClassifyWay(way.Tags) is { } kind)
            {
                foreach (var id in way.NodeIds)
                {
                    footway.TryAdd(id, kind);
                }
            }
        }

        CrossingKind? KindOf(long id) =>
            data.Nodes.TryGetValue(id, out var n) && ClassifyNode(n.Tags) is { } k ? k : footway.TryGetValue(id, out var f) ? f : null;

        // Mapped crossings: interior OSM nodes of links, and link ends at plain joints / mid-block signals.
        var mapped = new SortedDictionary<long, (CrossingKind Kind, List<Entry> Entries, NetworkNode? AtNode)>();
        foreach (var link in links)
        {
            for (var i = 1; i < link.OsmNodes.Count - 1; i++)
            {
                if (link.OsmNodes[i].Id is { } id && KindOf(id) is { } kind)
                {
                    var entry = new Entry(link, Math.Clamp(Project(link.Geometry, link.OsmNodes[i].Position), 0, link.Length));
                    Add(mapped, id, kind, entry, null);
                }
            }

            var end = ctx.NodeById[link.To];
            if (end.OsmId is { } endId && end.Control != NodeControl.Boundary && ctx.Legs(end) <= 2 && KindOf(endId) is { } endKind)
            {
                Add(mapped, endId, endKind, new Entry(link, link.Length), end);
            }
        }

        var candidates = new List<Candidate>();
        foreach (var (osmId, (kind, entries, atNode)) in mapped)
        {
            var (signalNode, group, mode) = kind == CrossingKind.Signal ? ctx.SignalFor(entries, atNode) : (null, null, CrossingSignalMode.None);
            candidates.Add(new Candidate(osmId, kind, entries, false, signalNode, group, mode));
        }

        foreach (var node in nodes.Where(n => n.Control == NodeControl.Signal))
        {
            candidates.AddRange(ctx.Implicit(node, candidates));
        }

        var result = new List<Crossing>();
        foreach (var c in candidates)
        {
            if (Create(c, $"x{result.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)}") is { } crossing)
            {
                result.Add(crossing);
            }
        }

        return result;
    }

    private static void Add(SortedDictionary<long, (CrossingKind, List<Entry>, NetworkNode?)> mapped, long id, CrossingKind kind, Entry entry, NetworkNode? atNode)
    {
        if (!mapped.TryGetValue(id, out var existing))
        {
            mapped[id] = (kind, [entry], atNode);
        }
        else if (existing.Item2.Count < 2 && existing.Item2.All(e => e.Link.Id != entry.Link.Id))
        {
            existing.Item2.Add(entry);
        }
    }

    private static Crossing? Create(Candidate c, string id)
    {
        var a = c.Entries[0];
        var widthA = a.Link.TotalWidth;
        var p0 = Kerb(a.Link, a.Position, right: true);
        Vec3 p1;
        double width;
        var spans = new List<CrossingLink>();
        if (c.Entries.Count > 1)
        {
            var b = c.Entries[1];
            var widthB = b.Link.TotalWidth;
            p1 = Kerb(b.Link, b.Position, right: true);
            width = Math.Clamp((p1 - p0).PlanarLength, widthA + widthB, widthA + widthB + 6);
            spans.Add(new CrossingLink(a.Link.Id, R(a.Position), 0, R(widthA)));
            spans.Add(new CrossingLink(b.Link.Id, R(b.Position), R(width - widthB), R(width)));
        }
        else
        {
            p1 = Kerb(a.Link, a.Position, right: false);
            width = widthA;
            spans.Add(new CrossingLink(a.Link.Id, R(a.Position), 0, R(widthA)));
        }

        if (width < 0.5)
        {
            return null;
        }

        return new Crossing
        {
            Id = id,
            OsmId = c.OsmId,
            Kind = c.Kind,
            NodeId = c.SignalNode?.Id,
            SignalGroup = c.Group,
            SignalMode = c.Group is null ? CrossingSignalMode.None : c.Mode,
            Implicit = c.Implicit,
            Width = R(width),
            Depth = c.Kind == CrossingKind.Signal ? SignalDepth : OtherDepth,
            Demand = R(BaseDemand(a.Link.RoadClass, c.Kind, c.Implicit)),
            Geometry = [p0, p1],
            Links = spans,
        };
    }

    private static double R(double v) => Math.Round(v, 3);

    /// <summary>Right (or left) kerb of a link's carriageway at <paramref name="position"/> along the link.</summary>
    private static Vec3 Kerb(Link link, double position, bool right)
    {
        var lane = right ? link.Lanes[0] : link.Lanes[^1];
        var length = Polyline.PlanarLength(lane.Geometry);
        var linkLength = Math.Max(Polyline.PlanarLength(link.Geometry), 1e-9);
        var s = Math.Clamp(position * length / linkLength, 0, length);
        var point = Polyline.PointAt(lane.Geometry, s);
        var dir = (Polyline.PointAt(lane.Geometry, Math.Min(length, s + 0.5)) - Polyline.PointAt(lane.Geometry, Math.Max(0, s - 0.5))).PlanarNormalized();
        if (dir.PlanarLength < 1e-9)
        {
            dir = Polyline.Direction(lane.Geometry, atEnd: false);
        }

        var normal = dir.RightNormal() * (lane.Width / 2);
        return right ? point + normal : point - normal;
    }

    /// <summary>Planar distance along <paramref name="points"/> of the point closest to <paramref name="p"/>.</summary>
    private static double Project(IReadOnlyList<Vec3> points, Vec3 p)
    {
        var best = double.MaxValue;
        var along = 0.0;
        var result = 0.0;
        for (var i = 1; i < points.Count; i++)
        {
            var a = points[i - 1];
            var d = points[i] - a;
            var len2 = (d.X * d.X) + (d.Y * d.Y);
            var t = len2 < 1e-12 ? 0 : Math.Clamp((((p.X - a.X) * d.X) + ((p.Y - a.Y) * d.Y)) / len2, 0, 1);
            var q = a + (d * t);
            var dist = (p - q).PlanarLength;
            if (dist < best)
            {
                best = dist;
                result = along + (Math.Sqrt(len2) * t);
            }

            along += Math.Sqrt(len2);
        }

        return result;
    }

    private sealed class Context
    {
        private readonly IReadOnlyList<Link> _links;
        private readonly ILookup<string, Connector> _connectorsByFrom;
        private readonly Dictionary<string, SignalController> _signalByNode;

        public Context(IReadOnlyList<NetworkNode> nodes, IReadOnlyList<Link> links, IReadOnlyList<Connector> connectors, IReadOnlyList<SignalController> signals)
        {
            _links = links;
            NodeById = nodes.ToDictionary(n => n.Id, StringComparer.Ordinal);
            LinkById = links.ToDictionary(l => l.Id, StringComparer.Ordinal);
            _connectorsByFrom = connectors.ToLookup(c => c.FromLink, StringComparer.Ordinal);
            _signalByNode = signals.GroupBy(s => s.NodeId, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        }

        public Dictionary<string, NetworkNode> NodeById { get; }

        public Dictionary<string, Link> LinkById { get; }

        /// <summary>Legs of a node: (incoming, outgoing) links of the same road, either may be null for one-way roads.</summary>
        public List<(Link? In, Link? Out)> LegsOf(NetworkNode node)
        {
            var legs = new List<(Link? In, Link? Out)>();
            var outgoing = _links.Where(l => l.From == node.Id).ToList();
            foreach (var incoming in _links.Where(l => l.To == node.Id))
            {
                var partner = outgoing.FirstOrDefault(o => o.Id == incoming.OppositeLinkId);
                if (partner is not null)
                {
                    outgoing.Remove(partner);
                }

                legs.Add((incoming, partner));
            }

            legs.AddRange(outgoing.Select(o => ((Link?)null, (Link?)o)));
            return legs;
        }

        public int Legs(NetworkNode node) => LegsOf(node).Count;

        private string? FirstGroup(NetworkNode node) =>
            _signalByNode.TryGetValue(node.Id, out var s) && s.Groups.Count > 0 ? s.Groups[0].Id : null;

        private bool AlwaysGreen(NetworkNode node, string group) =>
            _signalByNode.TryGetValue(node.Id, out var s) && s.Groups.FirstOrDefault(g => g.Id == group) is { } g
            && g.Green.Sum(i => i.End - i.Start) >= s.Cycle - 1e-6;

        private string? GroupOf(Link incoming) => _connectorsByFrom[incoming.Id].Select(c => c.SignalGroup).FirstOrDefault(g => g is not null);

        /// <summary>
        /// Signal group whose approaches run perpendicular to the leg (pedestrians crossing the leg walk with
        /// them); null when none differs from the leg's own approach group.
        /// </summary>
        private string? ParallelGroup(NetworkNode node, (Link? In, Link? Out) leg)
        {
            var legDir = leg.Out is { } o ? Polyline.Direction(o.Geometry, atEnd: false) : Polyline.Direction(leg.In!.Geometry, atEnd: true);
            var own = leg.In is { } i ? GroupOf(i) : null;
            string? best = null;
            var bestSin = 0.7;
            var skippedAlways = false;
            foreach (var approach in _links.Where(l => l.To == node.Id && l != leg.In))
            {
                // An always-green group (#117, movements inside a junction) would give pedestrians permanent green.
                if (GroupOf(approach) is not { } group)
                {
                    continue;
                }

                if (AlwaysGreen(node, group))
                {
                    skippedAlways = true;
                    continue;
                }

                var dir = Polyline.Direction(approach.Geometry, atEnd: true);
                var sin = Math.Abs((dir.X * legDir.Y) - (dir.Y * legDir.X));
                if (sin > bestSin + 1e-9)
                {
                    bestSin = sin;
                    best = group;
                }
            }

            if (best is null && skippedAlways && _signalByNode.TryGetValue(node.Id, out var s))
            {
                // Only always-green movements run across the leg: pedestrians walk while the leg's own traffic is red.
                best = s.Groups.Select(g => g.Id).FirstOrDefault(g => g != own && !AlwaysGreen(node, g));
            }

            return best == own ? null : best;
        }

        /// <summary>Signal node, group and mode of a mapped signal crossing.</summary>
        public (NetworkNode? Node, string? Group, CrossingSignalMode Mode) SignalFor(List<Entry> entries, NetworkNode? atNode)
        {
            NetworkNode? node = atNode is { Control: NodeControl.Signal } ? atNode : null;
            if (node is null)
            {
                var best = SignalReachMetres;
                foreach (var e in entries)
                {
                    foreach (var (candidate, distance) in new[] { (NodeById[e.Link.To], e.Link.Length - e.Position), (NodeById[e.Link.From], e.Position) })
                    {
                        if (candidate.Control == NodeControl.Signal && distance <= best)
                        {
                            best = distance;
                            node = candidate;
                        }
                    }
                }
            }

            if (node is null)
            {
                return (null, null, CrossingSignalMode.None);
            }

            var legs = LegsOf(node);
            if (legs.Count <= 2)
            {
                return (node, FirstGroup(node), CrossingSignalMode.Request);
            }

            var linkIds = entries.Select(e => e.Link.Id).ToHashSet(StringComparer.Ordinal);
            var leg = legs.FirstOrDefault(l => (l.In is { } i && linkIds.Contains(i.Id)) || (l.Out is { } o && linkIds.Contains(o.Id)));
            return leg == default ? (node, null, CrossingSignalMode.None) : (node, ParallelGroup(node, leg), CrossingSignalMode.Parallel);
        }

        /// <summary>Implicit crosswalks of a signal node: one per junction leg, or one at a mid-block signal.</summary>
        public IEnumerable<Candidate> Implicit(NetworkNode node, IReadOnlyList<Candidate> mapped)
        {
            bool Covered(Link? link, bool outgoing) =>
                link is not null && mapped.Any(c => !c.Implicit && c.Entries.Any(e => e.Link.Id == link.Id
                    && (outgoing ? e.Position : link.Length - e.Position) <= ImplicitReplaceMetres));

            var legs = LegsOf(node);
            if (legs.Count <= 2)
            {
                if (mapped.Any(c => c.SignalNode == node) || legs.Any(l => Covered(l.In, false) || Covered(l.Out, true)))
                {
                    yield break;
                }

                var entries = legs.Where(l => l.In is not null).Select(l => new Entry(l.In!, l.In!.Length)).ToList();
                if (entries.Count > 0 && FirstGroup(node) is { } group)
                {
                    yield return new Candidate(null, CrossingKind.Signal, entries, true, node, group, CrossingSignalMode.Request);
                }

                yield break;
            }

            bool Inner(Link? link, bool outgoing) =>
                link is not null && link.Length < InnerLegMetres
                && NodeById[outgoing ? link.To : link.From].Control is not (NodeControl.None or NodeControl.Boundary);

            foreach (var leg in legs)
            {
                if (Covered(leg.In, false) || Covered(leg.Out, true) || Inner(leg.In, false) || Inner(leg.Out, true)
                    || ParallelGroup(node, leg) is not { } group)
                {
                    continue;
                }

                var entries = new List<Entry>();
                if (leg.Out is { } o)
                {
                    entries.Add(new Entry(o, Math.Min((SignalDepth / 2) + 0.5, o.Length / 2)));
                }

                if (leg.In is { } i)
                {
                    entries.Add(new Entry(i, i.Length - Math.Min((SignalDepth / 2) + 0.5, i.Length / 2)));
                }

                yield return new Candidate(null, CrossingKind.Signal, entries, true, node, group, CrossingSignalMode.Parallel);
            }
        }
    }
}
