using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using TrafficSim.Application.Networks;
using TrafficSim.Domain.Activity;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Application.Scenarios;

/// <summary>Data basis of the generated scenarios, stored with the baseline and shown in the UI.</summary>
/// <param name="HasActivityData">False when only the road network was available (time-of-day profiles only).</param>
/// <param name="Features">Number of classified features per kind.</param>
/// <param name="Totals">Summed weights per kind (dwelling units, jobs, …).</param>
/// <param name="HousingUnitsPerKm2">Density that drives the car share.</param>
/// <param name="CarShare">Assumed share of trips made by car.</param>
/// <param name="ExternalShare">Share of commuter trips leaving or entering the area.</param>
/// <param name="Zones">Number of traffic zones.</param>
/// <param name="UnattachedFeatures">Features without a drivable road within reach.</param>
public sealed record ActivitySummary(
    bool HasActivityData,
    IReadOnlyDictionary<string, int> Features,
    IReadOnlyDictionary<string, double> Totals,
    double HousingUnitsPerKm2,
    double CarShare,
    double ExternalShare,
    int Zones,
    int UnattachedFeatures);

/// <summary>A scenario proposal produced at import time.</summary>
public sealed record GeneratedScenario(string Key, string Name, string Description, double StartTimeOfDay, double DurationSeconds, string DemandJson);

/// <summary>
/// Generates a set of what-if scenarios for an imported network from OSM buildings, land use and POIs
/// (#115): features are attached to nearby drivable links and aggregated into 500 m zones; trips are
/// generated per purpose (rates × density-dependent car share) and distributed with a gravity model;
/// through traffic comes from the sim core's road-class profiles at the boundary entries. All rates are
/// documented assumptions — OSM has no traffic counts — and every scenario stays editable.
/// </summary>
public static class ScenarioGenerator
{
    public const double ZoneSize = 500;
    public const double SnapRadius = 250;
    public const double GravityBeta = 1500;
    private const double PersonsPerUnit = 2.0;
    private const string External = "ext";

    private static readonly HashSet<string> NoDestinationClasses = new(StringComparer.Ordinal)
    {
        "motorway", "motorway_link", "trunk", "trunk_link",
    };

    /// <summary>Built-in sim-core road-class volumes (veh/h/lane, sim-core/README.md) for scaled scenarios.</summary>
    internal static readonly IReadOnlyDictionary<string, double> RoadClassVolumes = new Dictionary<string, double>(StringComparer.Ordinal)
    {
        ["motorway"] = 1400, ["trunk"] = 1000, ["motorway_link"] = 600, ["primary"] = 600, ["trunk_link"] = 400,
        ["secondary"] = 400, ["primary_link"] = 300, ["tertiary"] = 250, ["secondary_link"] = 200, ["road"] = 150,
        ["tertiary_link"] = 150, ["unclassified"] = 120, ["residential"] = 60, ["service"] = 30, ["busway"] = 30, ["living_street"] = 20,
    };

    private sealed class Zone(string id)
    {
        public string Id { get; } = id;

        public double X { get; set; }

        public double Y { get; set; }

        public int Count { get; set; }

        public SortedSet<string> Links { get; } = new(StringComparer.Ordinal);

        public Dictionary<ActivityKind, double> Weights { get; } = [];

        public double W(ActivityKind k) => Weights.GetValueOrDefault(k);
    }

    private sealed record Flow(ActivityKind From, ActivityKind To, double RatePerUnit, string Curve);

    private sealed record Definition(
        string Key, string Name, string Description, double Start, double Duration,
        IReadOnlyList<Flow> Flows, double InboundCommutersPerJob, double FreightPerUnit, double Scale,
        string? BoundaryCurve, double BoundaryScale, bool Commuting, string FallbackCurve);

    public static (IReadOnlyList<GeneratedScenario> Scenarios, ActivitySummary Summary) Generate(
        NetworkPackage package, IReadOnlyList<OsmPoi> pois, double areaKm2)
    {
        ArgumentNullException.ThrowIfNull(package);
        ArgumentNullException.ThrowIfNull(pois);
        var features = pois.SelectMany(ActivityClassifier.Classify).ToList();
        var plane = new LocalTangentPlane(new GeoPoint(package.Origin.Lat, package.Origin.Lon));
        var index = new LinkIndex(package);
        var zones = new SortedDictionary<string, Zone>(StringComparer.Ordinal);
        var unattached = 0;
        foreach (var f in features.Where(f => f.Kind != ActivityKind.Parking))
        {
            var p = plane.ToLocal(f.Location);
            var link = index.Nearest(p.East, p.North, SnapRadius);
            if (link is null)
            {
                unattached++;
                continue;
            }

            var key = string.Create(CultureInfo.InvariantCulture, $"z{Math.Floor(p.East / ZoneSize)}_{Math.Floor(p.North / ZoneSize)}");
            if (!zones.TryGetValue(key, out var zone))
            {
                zones[key] = zone = new Zone(key);
            }

            zone.Links.Add(link);
            zone.Weights[f.Kind] = zone.W(f.Kind) + f.Weight;
            zone.X += p.East;
            zone.Y += p.North;
            zone.Count++;
        }

        foreach (var z in zones.Values)
        {
            z.X /= z.Count;
            z.Y /= z.Count;
        }

        var totals = Enum.GetValues<ActivityKind>().ToDictionary(k => k, k => features.Where(f => f.Kind == k).Sum(f => f.Weight));
        var area = Math.Max(areaKm2, 0.01);
        var density = totals[ActivityKind.Housing] / area;
        var carShare = Math.Round(Math.Clamp(0.7 - (0.00005 * density), 0.2, 0.7), 3);
        var externalShare = Math.Round(Math.Clamp(1 - (area / 25), 0.3, 0.85), 3);
        var hasData = zones.Values.Any(z => z.W(ActivityKind.Housing) > 0 || z.W(ActivityKind.Work) > 0);

        var summary = new ActivitySummary(
            hasData,
            Enum.GetValues<ActivityKind>().ToDictionary(k => Camel(k), k => features.Count(f => f.Kind == k)),
            totals.ToDictionary(kv => Camel(kv.Key), kv => Math.Round(kv.Value)),
            Math.Round(density),
            carShare,
            externalShare,
            zones.Count,
            unattached);

        var boundary = package.Nodes.Where(n => n.Control == "boundary").Select(n => n.Id).ToList();
        var scenarios = Definitions(totals)
            .Select(d => new GeneratedScenario(d.Key, d.Name, d.Description, d.Start, d.Duration,
                hasData ? Demand(d, zones.Values.ToList(), boundary, carShare, externalShare) : FallbackDemand(d)))
            .ToList();
        return (scenarios, summary);
    }

    private static List<Definition> Definitions(IReadOnlyDictionary<ActivityKind, double> totals)
    {
        var list = new List<Definition>
        {
            new("morning", "Weekday morning peak", "Commuters and school runs from residential areas to jobs and schools, inbound commuters, through traffic.",
                6.5 * 3600, 3 * 3600,
                [new(ActivityKind.Housing, ActivityKind.Work, PersonsPerUnit * 0.10, "morningPeak"), new(ActivityKind.Housing, ActivityKind.Education, 0.04, "morningPeak")],
                0.10, 0.2, 1.0, null, 1.0, true, "commuterOut"),
            new("midday", "Weekday midday", "Shopping, business and delivery traffic between the peaks.",
                11 * 3600, 2 * 3600,
                [new(ActivityKind.Housing, ActivityKind.Retail, 0.03, "flat"), new(ActivityKind.Work, ActivityKind.Work, 0.02, "flat"), new(ActivityKind.Work, ActivityKind.Retail, 0.01, "flat")],
                0, 0.4, 1.0, null, 1.0, false, "flat"),
            new("evening", "Weekday evening peak", "Commuters returning home, after-work shopping, outbound commuters, through traffic.",
                15.5 * 3600, 3.5 * 3600,
                [new(ActivityKind.Work, ActivityKind.Housing, 0.10, "eveningPeak"), new(ActivityKind.Housing, ActivityKind.Retail, 0.03, "eveningPeak")],
                0, 0.15, 1.0, null, 1.0, true, "commuterIn"),
            new("saturday", "Saturday shopping", "Shopping and leisure trips, little commuting, reduced through traffic.",
                10 * 3600, 4 * 3600,
                [new(ActivityKind.Housing, ActivityKind.Retail, 0.07, "flat"), new(ActivityKind.Housing, ActivityKind.Leisure, 0.015, "flat")],
                0, 0.05, 1.0, "flat", 0.6, false, "flat"),
            new("night", "Night", "Low traffic: shift workers and late returns.",
                22 * 3600, 2 * 3600,
                [new(ActivityKind.Housing, ActivityKind.Work, 0.005, "flat"), new(ActivityKind.Work, ActivityKind.Housing, 0.01, "flat")],
                0, 0.02, 1.0, null, 1.0, false, "flat"),
            new("stress", "Morning peak +30 % (stress test)", "The morning peak with 30 % more traffic everywhere — where does the network break down first?",
                6.5 * 3600, 3 * 3600,
                [new(ActivityKind.Housing, ActivityKind.Work, PersonsPerUnit * 0.10, "morningPeak"), new(ActivityKind.Housing, ActivityKind.Education, 0.04, "morningPeak")],
                0.10, 0.2, 1.3, null, 1.3, true, "commuterOut"),
        };

        if (totals[ActivityKind.Leisure] >= 1500)
        {
            list.Add(new("event", "Evening event", "Visitors arriving at stadiums, theatres and venues in the evening.",
                17.5 * 3600, 2.5 * 3600,
                [new(ActivityKind.Housing, ActivityKind.Leisure, 0.03, "flat")],
                0, 0.02, 1.0, null, 1.0, false, "flat"));
        }

        if (totals[ActivityKind.Freight] >= 100)
        {
            list.Add(new("freight", "Logistics day", "Heavy goods traffic to and from industrial and warehouse areas.",
                8 * 3600, 4 * 3600,
                [new(ActivityKind.Housing, ActivityKind.Work, PersonsPerUnit * 0.03, "flat")],
                0.03, 1.2, 1.0, null, 1.0, false, "flat"));
        }

        return list;
    }

    private static string Demand(Definition d, List<Zone> zones, List<string> boundary, double carShare, double externalShare)
    {
        var od = new List<(string From, string To, double Vph, string Curve, bool Freight)>();
        var hasExternal = boundary.Count > 0;

        foreach (var flow in d.Flows)
        {
            var targets = zones.Where(z => z.W(flow.To) > 0).ToList();
            foreach (var origin in zones.Where(z => z.W(flow.From) > 0))
            {
                var produced = origin.W(flow.From) * flow.RatePerUnit * carShare * d.Scale;
                var ext = hasExternal ? (targets.Count == 0 ? 1 : externalShare) : 0;
                if (ext > 0)
                {
                    od.Add((origin.Id, External, produced * ext, flow.Curve, false));
                }

                var inside = produced * (1 - ext);
                if (inside <= 0 || targets.Count == 0)
                {
                    continue;
                }

                var weighted = targets
                    .Select(t => (Zone: t, W: t.W(flow.To) * Math.Exp(-Distance(origin, t) / GravityBeta) * (t == origin ? 0.3 : 1)))
                    .OrderByDescending(x => x.W)
                    .Take(5)
                    .ToList();
                var sum = weighted.Sum(x => x.W);
                foreach (var (zone, w) in weighted)
                {
                    od.Add((origin.Id, zone.Id, inside * w / sum, flow.Curve, false));
                }
            }
        }

        if (hasExternal && d.InboundCommutersPerJob > 0)
        {
            // Jobs filled by commuters from outside the area.
            foreach (var z in zones.Where(z => z.W(ActivityKind.Work) > 0))
            {
                od.Add((External, z.Id, z.W(ActivityKind.Work) * d.InboundCommutersPerJob * carShare * externalShare * d.Scale, d.Commuting ? "morningPeak" : "flat", false));
            }
        }

        if (hasExternal && d.Key == "evening")
        {
            // Residents returning from jobs outside the area.
            foreach (var z in zones.Where(z => z.W(ActivityKind.Housing) > 0))
            {
                od.Add((External, z.Id, z.W(ActivityKind.Housing) * PersonsPerUnit * 0.10 * carShare * externalShare * d.Scale, "eveningPeak", false));
            }
        }

        if (hasExternal && d.FreightPerUnit > 0)
        {
            foreach (var z in zones.Where(z => z.W(ActivityKind.Freight) > 0))
            {
                var trucks = z.W(ActivityKind.Freight) * d.FreightPerUnit * 0.1 * d.Scale;
                od.Add((External, z.Id, trucks / 2, "flat", true));
                od.Add((z.Id, External, trucks / 2, "flat", true));
            }
        }

        var used = od.Where(o => o.Vph >= 0.2).ToList();
        var usedZones = used.SelectMany(o => new[] { o.From, o.To }).ToHashSet(StringComparer.Ordinal);
        var zoneArray = new JsonArray();
        foreach (var z in zones.Where(z => usedZones.Contains(z.Id)))
        {
            zoneArray.Add(new JsonObject { ["id"] = z.Id, ["links"] = new JsonArray(z.Links.Select(l => (JsonNode)JsonValue.Create(l)!).ToArray()) });
        }

        if (usedZones.Contains(External))
        {
            zoneArray.Add(new JsonObject { ["id"] = External, ["nodes"] = new JsonArray(boundary.Select(n => (JsonNode)JsonValue.Create(n)!).ToArray()) });
        }

        var odArray = new JsonArray();
        foreach (var o in used)
        {
            var entry = new JsonObject { ["from"] = o.From, ["to"] = o.To, ["vph"] = Math.Round(o.Vph, 2), ["curve"] = o.Curve };
            if (o.Freight)
            {
                entry["vehicleMix"] = new JsonObject { ["truck"] = 0.4, ["articulatedTruck"] = 0.4, ["van"] = 0.2 };
            }

            if (d.Commuting && !o.Freight)
            {
                entry["driverMix"] = new JsonObject { ["commuter"] = 5, ["average"] = 3, ["attentive"] = 1, ["distracted"] = 0.5, ["aggressive"] = 0.5 };
            }

            odArray.Add(entry);
        }

        var demand = Base(d);
        demand["autoZones"] = false;
        demand["zones"] = zoneArray;
        demand["od"] = odArray;
        return demand.ToJsonString();
    }

    /// <summary>Without buildings/POIs: residential trip generation from road lengths plus profiles.</summary>
    private static string FallbackDemand(Definition d)
    {
        var demand = Base(d);
        demand["autoZones"] = true;
        var rate = Math.Round(40 * d.Scale * (d.Commuting ? 1 : 0.3), 1);
        demand["residential"] = new JsonObject
        {
            ["outboundPerKm"] = rate,
            ["inboundPerKm"] = rate,
            ["outboundCurve"] = d.Key == "evening" ? "flat" : d.FallbackCurve,
            ["inboundCurve"] = d.Key == "morning" || d.Key == "stress" ? "flat" : d.FallbackCurve,
        };
        return demand.ToJsonString();
    }

    private static JsonObject Base(Definition d)
    {
        var demand = new JsonObject
        {
            ["startTimeOfDay"] = d.Start,
            ["autoEntries"] = true,
            ["vehicleMix"] = new JsonObject { ["car"] = 0.85, ["van"] = 0.07, ["truck"] = 0.03, ["articulatedTruck"] = 0.02, ["motorcycle"] = 0.03 },
            ["driverMix"] = new JsonObject { ["average"] = 5, ["attentive"] = 2, ["commuter"] = d.Commuting ? 3 : 1, ["distracted"] = 1, ["aggressive"] = 1 },
        };
        if (d.BoundaryCurve is not null)
        {
            demand["demandCurve"] = d.BoundaryCurve;
        }

        if (Math.Abs(d.BoundaryScale - 1) > 1e-9)
        {
            var profiles = new JsonObject();
            foreach (var (cls, volume) in RoadClassVolumes)
            {
                profiles[cls] = new JsonObject { ["volumePerLane"] = Math.Round(volume * d.BoundaryScale), ["curve"] = d.BoundaryCurve ?? "weekday" };
            }

            demand["profiles"] = profiles;
        }

        return demand;
    }

    private static double Distance(Zone a, Zone b) => Math.Sqrt(Math.Pow(a.X - b.X, 2) + Math.Pow(a.Y - b.Y, 2));

    private static string Camel(ActivityKind k) => JsonNamingPolicy.CamelCase.ConvertName(k.ToString());

    /// <summary>Grid index of drivable link segments that can be trip origins/destinations.</summary>
    private sealed class LinkIndex
    {
        private const double Cell = 100;
        private readonly Dictionary<(long, long), List<(string Link, double Ax, double Ay, double Bx, double By)>> _cells = [];

        public LinkIndex(NetworkPackage package)
        {
            foreach (var link in package.Links)
            {
                if (NoDestinationClasses.Contains(link.RoadClass) || !link.Lanes.Any(l => l.Allowed.Contains("car")))
                {
                    continue;
                }

                for (var i = 1; i < link.Geometry.Count; i++)
                {
                    var (a, b) = (link.Geometry[i - 1], link.Geometry[i]);
                    for (var x = Math.Floor(Math.Min(a[0], b[0]) / Cell); x <= Math.Floor(Math.Max(a[0], b[0]) / Cell); x++)
                    {
                        for (var y = Math.Floor(Math.Min(a[1], b[1]) / Cell); y <= Math.Floor(Math.Max(a[1], b[1]) / Cell); y++)
                        {
                            var key = ((long)x, (long)y);
                            if (!_cells.TryGetValue(key, out var list))
                            {
                                _cells[key] = list = [];
                            }

                            list.Add((link.Id, a[0], a[1], b[0], b[1]));
                        }
                    }
                }
            }
        }

        public string? Nearest(double x, double y, double radius)
        {
            var r = (long)Math.Ceiling(radius / Cell);
            var cx = (long)Math.Floor(x / Cell);
            var cy = (long)Math.Floor(y / Cell);
            string? best = null;
            var bestD = radius;
            for (var i = cx - r; i <= cx + r; i++)
            {
                for (var j = cy - r; j <= cy + r; j++)
                {
                    if (!_cells.TryGetValue((i, j), out var list))
                    {
                        continue;
                    }

                    foreach (var s in list)
                    {
                        var d = SegmentDistance(x, y, s.Ax, s.Ay, s.Bx, s.By);
                        if (d < bestD || (Math.Abs(d - bestD) < 1e-9 && best is not null && string.CompareOrdinal(s.Link, best) < 0))
                        {
                            bestD = d;
                            best = s.Link;
                        }
                    }
                }
            }

            return best;
        }

        private static double SegmentDistance(double px, double py, double ax, double ay, double bx, double by)
        {
            var dx = bx - ax;
            var dy = by - ay;
            var len = (dx * dx) + (dy * dy);
            var t = len < 1e-12 ? 0 : Math.Clamp((((px - ax) * dx) + ((py - ay) * dy)) / len, 0, 1);
            return Math.Sqrt(Math.Pow(px - (ax + (t * dx)), 2) + Math.Pow(py - (ay + (t * dy)), 2));
        }
    }
}
