namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Layer, structure and schematic elevation for bridges and tunnels (#93, ADR-0016).</summary>
public static class GradeSeparationRule
{
    public const double MetresPerLayerUp = 6;
    public const double MetresPerLayerDown = 8;

    public static (int Layer, Structure Structure) Parse(IReadOnlyDictionary<string, string> tags)
    {
        ArgumentNullException.ThrowIfNull(tags);
        var bridge = Tags.Get(tags, "bridge");
        var tunnel = Tags.Get(tags, "tunnel");
        var structure = Structure.None;
        if (bridge is not null && !Tags.IsNo(bridge))
        {
            structure = Structure.Bridge;
        }
        else if (tunnel is not null && !Tags.IsNo(tunnel))
        {
            structure = tunnel == "building_passage" ? Structure.Covered : Structure.Tunnel;
        }
        else if (Tags.IsYes(Tags.Get(tags, "covered")))
        {
            structure = Structure.Covered;
        }

        var layer = Tags.GetInt(tags, "layer") ?? structure switch
        {
            Structure.Bridge => 1,
            Structure.Tunnel => -1,
            _ => 0,
        };
        return (Math.Clamp(layer, -5, 5), structure);
    }

    public static double Elevation(int level) => level >= 0 ? level * MetresPerLayerUp : level * MetresPerLayerDown;

    /// <summary>The level of a node: the incident layer closest to ground.</summary>
    public static int NodeLevel(IEnumerable<int> incidentLayers) =>
        incidentLayers.DefaultIfEmpty(0).OrderBy(Math.Abs).ThenBy(l => l).First();

    /// <summary>
    /// Elevation along a link: starts and ends at its nodes' elevations and reaches the link's own layer
    /// in between, with ramps of up to 40 % of the length (max 100 m) at each end.
    /// </summary>
    public static double Profile(double distance, double length, double startZ, double endZ, double layerZ)
    {
        if (length <= 0)
        {
            return startZ;
        }

        var ramp = Math.Min(0.4 * length, 100);
        var fromStart = Smooth(1 - Math.Clamp(distance / ramp, 0, 1));
        var fromEnd = Smooth(1 - Math.Clamp((length - distance) / ramp, 0, 1));
        return layerZ + ((startZ - layerZ) * fromStart) + ((endZ - layerZ) * fromEnd);
    }

    /// <summary>Applies the profile; non-flat profiles are resampled every <paramref name="step"/> metres.</summary>
    public static IReadOnlyList<Vec3> Apply(IReadOnlyList<Vec3> points, double startZ, double endZ, double layerZ, double step = 10)
    {
        ArgumentNullException.ThrowIfNull(points);
        var length = Polyline.PlanarLength(points);
        var flat = Math.Abs(startZ - layerZ) < 1e-9 && Math.Abs(endZ - layerZ) < 1e-9;
        var distances = new List<double>();
        var acc = 0.0;
        for (var i = 0; i < points.Count; i++)
        {
            if (i > 0)
            {
                var seg = (points[i] - points[i - 1]).PlanarLength;
                if (!flat)
                {
                    for (var d = step; d < seg - 1e-6; d += step)
                    {
                        distances.Add(acc + d);
                    }
                }

                acc += seg;
            }

            distances.Add(acc);
        }

        return distances.Select(d => Polyline.PointAt(points, d).WithZ(Profile(d, length, startZ, endZ, layerZ))).ToList();
    }

    private static double Smooth(double t) => t * t * (3 - (2 * t));
}
