using System.Text.Json.Nodes;
using TrafficSim.Application.Networks;
using TrafficSim.Domain.Activity;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Application.Scenarios;

/// <summary>
/// Pedestrian demand per crossing for generated scenarios (ADR-0020, #86). The package carries a base
/// estimate per crossing (road class × kind). Here it is scaled by the activity around the crossing:
/// shops, schools, jobs, dwellings and venues within <see cref="Radius"/> metres add pedestrian intensity
/// with a linear distance decay, and the multiplier <c>0.5 + intensity / 400</c> is clamped to
/// [<see cref="MinMultiplier"/>, <see cref="MaxMultiplier"/>]. A scenario factor reflects the time of day
/// (night 0.15, Saturday shopping 1.3, …). All of it is a documented assumption: OSM has no pedestrian
/// counts, and every value stays editable in the scenario (<c>pedestrians.crossings</c>).
/// </summary>
public static class PedestrianDemand
{
    public const double Radius = 250;
    public const double MinMultiplier = 0.5;
    public const double MaxMultiplier = 4;
    private const double IntensityScale = 400;

    /// <summary>Pedestrian intensity per activity unit (retail units, pupils, jobs, dwellings, visitors).</summary>
    private static readonly Dictionary<ActivityKind, double> Intensity = new()
    {
        [ActivityKind.Retail] = 2,
        [ActivityKind.Education] = 0.3,
        [ActivityKind.Work] = 0.2,
        [ActivityKind.Housing] = 0.5,
        [ActivityKind.Leisure] = 0.05,
    };

    /// <summary>Scenario factors by generated scenario key (1 for unknown keys).</summary>
    public static readonly IReadOnlyDictionary<string, double> ScenarioFactors = new Dictionary<string, double>(StringComparer.Ordinal)
    {
        ["morning"] = 1.0,
        ["midday"] = 1.2,
        ["evening"] = 1.1,
        ["saturday"] = 1.3,
        ["night"] = 0.15,
        ["stress"] = 1.0,
        ["event"] = 1.5,
        ["freight"] = 0.8,
    };

    /// <summary>
    /// Demand (pedestrians per hour) per crossing id from the activity around it; null when the package has no
    /// crossings, empty when there is no activity data (the package estimates apply).
    /// </summary>
    public static IReadOnlyDictionary<string, double>? Estimate(NetworkPackage package, IReadOnlyList<ActivityFeature> features)
    {
        ArgumentNullException.ThrowIfNull(package);
        ArgumentNullException.ThrowIfNull(features);
        if (package.Crossings is not { Count: > 0 } crossings)
        {
            return null;
        }

        var result = new SortedDictionary<string, double>(StringComparer.Ordinal);
        if (features.Count == 0)
        {
            return result;
        }

        var plane = new LocalTangentPlane(new GeoPoint(package.Origin.Lat, package.Origin.Lon));
        var points = features
            .Where(f => Intensity.ContainsKey(f.Kind))
            .Select(f => (P: plane.ToLocal(f.Location), W: f.Weight * Intensity[f.Kind]))
            .ToList();
        foreach (var x in crossings)
        {
            if (x.Geometry.Count == 0)
            {
                continue;
            }

            var cx = x.Geometry.Average(p => p[0]);
            var cy = x.Geometry.Average(p => p[1]);
            var intensity = 0.0;
            foreach (var (p, w) in points)
            {
                var d = Math.Sqrt(Math.Pow(p.East - cx, 2) + Math.Pow(p.North - cy, 2));
                if (d < Radius)
                {
                    intensity += w * (1 - (d / Radius));
                }
            }

            var multiplier = Math.Clamp(MinMultiplier + (intensity / IntensityScale), MinMultiplier, MaxMultiplier);
            result[x.Id] = Math.Round(x.Demand * multiplier, 1);
        }

        return result;
    }

    /// <summary>Adds the <c>pedestrians</c> section to a scenario demand (unchanged when the package has no crossings).</summary>
    public static string Apply(string demandJson, string scenarioKey, IReadOnlyDictionary<string, double>? crossings)
    {
        if (crossings is null)
        {
            return demandJson;
        }

        var demand = JsonNode.Parse(demandJson)!.AsObject();
        var section = new JsonObject
        {
            ["demandFactor"] = ScenarioFactors.GetValueOrDefault(scenarioKey, 1.0),
        };
        if (crossings.Count > 0)
        {
            var map = new JsonObject();
            foreach (var (id, vph) in crossings)
            {
                map[id] = vph;
            }

            section["crossings"] = map;
        }

        demand["pedestrians"] = section;
        return demand.ToJsonString();
    }
}
