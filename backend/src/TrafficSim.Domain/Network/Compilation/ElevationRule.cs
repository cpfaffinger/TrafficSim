namespace TrafficSim.Domain.Network.Compilation;

/// <summary>
/// Terrain elevation of nodes and links (#87, ADR-0018): <c>z = ground + grade-separation offset</c>.
/// Ordinary links follow the (smoothed) terrain; bridges, tunnels, covered ways and links off the
/// ground layer interpolate the ground between their ends so decks stay smooth. Without terrain the
/// rule reproduces <see cref="GradeSeparationRule.Apply"/> exactly.
/// </summary>
public static class ElevationRule
{
    /// <summary>Spacing of terrain samples along links (m).</summary>
    public const double SampleStep = 10;

    /// <summary>Half width of the moving average along links (m); removes DEM noise from grades.</summary>
    public const double SmoothingRadius = 20;

    private static readonly double[] SmoothingOffsets = [-SmoothingRadius, -SmoothingRadius / 2, 0, SmoothingRadius / 2, SmoothingRadius];

    /// <summary>True when a link is on the ground and follows the terrain under it.</summary>
    public static bool FollowsTerrain(Structure structure, int layer) => structure == Structure.None && layer == 0;

    /// <summary>Ground height under a position (0 without terrain).</summary>
    public static double Ground(TerrainGrid? terrain, Vec3 position) => terrain?.HeightAt(position.X, position.Y) ?? 0;

    /// <summary>
    /// Elevation profile of a link: the grade-separation profile (<paramref name="startLevelZ"/>,
    /// <paramref name="endLevelZ"/>, <paramref name="layerZ"/>, ADR-0016) on top of the ground.
    /// With terrain the polyline is resampled every <see cref="SampleStep"/> metres.
    /// </summary>
    public static IReadOnlyList<Vec3> Apply(
        IReadOnlyList<Vec3> points, double startLevelZ, double endLevelZ, double layerZ, TerrainGrid? terrain, bool followsTerrain)
    {
        ArgumentNullException.ThrowIfNull(points);
        if (terrain is null || points.Count < 2)
        {
            return GradeSeparationRule.Apply(points, startLevelZ, endLevelZ, layerZ);
        }

        var length = Polyline.PlanarLength(points);
        var startGround = Ground(terrain, points[0]);
        var endGround = Ground(terrain, points[^1]);
        var smoothStart = followsTerrain ? Smoothed(points, length, 0, terrain) : 0;
        var smoothEnd = followsTerrain ? Smoothed(points, length, length, terrain) : 0;
        return SampleDistances(points).Select(d =>
        {
            var t = length > 0 ? d / length : 0;
            var ground = followsTerrain
                ? Smoothed(points, length, d, terrain) + ((startGround - smoothStart) * (1 - t)) + ((endGround - smoothEnd) * t)
                : startGround + ((endGround - startGround) * t);
            return Polyline.PointAt(points, d).WithZ(ground + GradeSeparationRule.Profile(d, length, startLevelZ, endLevelZ, layerZ));
        }).ToList();
    }

    /// <summary>
    /// Moving average of the terrain along the polyline around distance <paramref name="d"/>. Beyond the
    /// ends the profile is point-reflected at the end (exact for planar slopes, and terrain beyond the
    /// link's nodes does not leak in).
    /// </summary>
    private static double Smoothed(IReadOnlyList<Vec3> points, double length, double d, TerrainGrid terrain)
    {
        double At(double s)
        {
            var p = Polyline.PointAt(points, Math.Clamp(s, 0, length));
            return terrain.HeightAt(p.X, p.Y);
        }

        var sum = 0.0;
        foreach (var o in SmoothingOffsets)
        {
            var s = d + o;
            sum += s < 0 ? (2 * At(0)) - At(-s) : s > length ? (2 * At(length)) - At((2 * length) - s) : At(s);
        }

        return sum / SmoothingOffsets.Length;
    }

    /// <summary>Distances of the original vertices plus intermediate samples every <see cref="SampleStep"/> metres.</summary>
    private static List<double> SampleDistances(IReadOnlyList<Vec3> points)
    {
        var distances = new List<double> { 0 };
        var acc = 0.0;
        for (var i = 1; i < points.Count; i++)
        {
            var seg = (points[i] - points[i - 1]).PlanarLength;
            for (var d = SampleStep; d < seg - 1e-6; d += SampleStep)
            {
                distances.Add(acc + d);
            }

            acc += seg;
            distances.Add(acc);
        }

        return distances;
    }
}
