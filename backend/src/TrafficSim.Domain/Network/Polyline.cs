namespace TrafficSim.Domain.Network;

/// <summary>Polyline operations in the local plane (junction geometry, ADR-0007).</summary>
public static class Polyline
{
    public static double Length(IReadOnlyList<Vec3> points)
    {
        ArgumentNullException.ThrowIfNull(points);
        var total = 0.0;
        for (var i = 1; i < points.Count; i++)
        {
            total += (points[i] - points[i - 1]).Length;
        }

        return total;
    }

    public static double PlanarLength(IReadOnlyList<Vec3> points)
    {
        ArgumentNullException.ThrowIfNull(points);
        var total = 0.0;
        for (var i = 1; i < points.Count; i++)
        {
            total += (points[i] - points[i - 1]).PlanarLength;
        }

        return total;
    }

    public static IReadOnlyList<Vec3> Reverse(IReadOnlyList<Vec3> points) => points.Reverse().ToList();

    /// <summary>Point at planar distance <paramref name="distance"/> from the start (clamped).</summary>
    public static Vec3 PointAt(IReadOnlyList<Vec3> points, double distance)
    {
        ArgumentNullException.ThrowIfNull(points);
        if (distance <= 0)
        {
            return points[0];
        }

        for (var i = 1; i < points.Count; i++)
        {
            var seg = (points[i] - points[i - 1]).PlanarLength;
            if (distance <= seg && seg > 0)
            {
                var t = distance / seg;
                return points[i - 1] + ((points[i] - points[i - 1]) * t);
            }

            distance -= seg;
        }

        return points[^1];
    }

    /// <summary>Sub-polyline between planar distances <paramref name="from"/> and <paramref name="to"/>.</summary>
    public static IReadOnlyList<Vec3> Slice(IReadOnlyList<Vec3> points, double from, double to)
    {
        ArgumentNullException.ThrowIfNull(points);
        var result = new List<Vec3> { PointAt(points, from) };
        var acc = 0.0;
        for (var i = 1; i < points.Count; i++)
        {
            acc += (points[i] - points[i - 1]).PlanarLength;
            if (acc > from + 1e-9 && acc < to - 1e-9)
            {
                result.Add(points[i]);
            }
        }

        result.Add(PointAt(points, to));
        return result;
    }

    /// <summary>Unit direction at the start (or end) of the polyline, measured over up to <paramref name="span"/> metres.</summary>
    public static Vec3 Direction(IReadOnlyList<Vec3> points, bool atEnd, double span = 10)
    {
        ArgumentNullException.ThrowIfNull(points);
        var length = PlanarLength(points);
        var s = Math.Min(span, length);
        var (a, b) = atEnd ? (PointAt(points, length - s), points[^1]) : (points[0], PointAt(points, s));
        return (b - a).PlanarNormalized();
    }

    /// <summary>Offsets a polyline to the right by <paramref name="offset"/> metres (negative = left), with limited miters.</summary>
    public static IReadOnlyList<Vec3> Offset(IReadOnlyList<Vec3> points, double offset)
    {
        ArgumentNullException.ThrowIfNull(points);
        if (points.Count < 2 || offset == 0)
        {
            return points.ToList();
        }

        var result = new List<Vec3>(points.Count);
        for (var i = 0; i < points.Count; i++)
        {
            var prev = i > 0 ? (points[i] - points[i - 1]).PlanarNormalized() : (points[1] - points[0]).PlanarNormalized();
            var next = i < points.Count - 1 ? (points[i + 1] - points[i]).PlanarNormalized() : prev;
            var n1 = prev.RightNormal();
            var n2 = next.RightNormal();
            var miter = (n1 + n2).PlanarNormalized();
            var cos = (miter.X * n1.X) + (miter.Y * n1.Y);
            var scale = miter.PlanarLength < 1e-9 || cos < 0.5 ? 1 : 1 / cos;
            if (miter.PlanarLength < 1e-9)
            {
                miter = n1;
            }

            result.Add(points[i] + (miter * (offset * scale)));
        }

        return result;
    }

    /// <summary>
    /// Shifts a centreline sideways (positive = right of the direction of travel) by <paramref name="start"/> at
    /// its start and <paramref name="end"/> at its end, each easing to zero over <paramref name="taper"/> metres
    /// (#146: branches of forks and merges kept flush with the road they leave or join). Points are added
    /// every few metres along the tapers so the shift is smooth.
    /// </summary>
    public static IReadOnlyList<Vec3> ShiftEnds(IReadOnlyList<Vec3> points, double start, double end, double taper)
    {
        ArgumentNullException.ThrowIfNull(points);
        if (points.Count < 2 || (start == 0 && end == 0) || taper <= 0)
        {
            return points.ToList();
        }

        const double step = 4;
        var total = PlanarLength(points);
        var dense = new List<(Vec3 P, double S)>();
        var s0 = 0.0;
        for (var i = 0; i < points.Count - 1; i++)
        {
            var a = points[i];
            var b = points[i + 1];
            var len = (b - a).PlanarLength;
            dense.Add((a, s0));
            for (var d = step; d < len; d += step)
            {
                var at = s0 + d;
                if (at < taper || at > total - taper)
                {
                    dense.Add((a + ((b - a) * (d / len)), at));
                }
            }

            s0 += len;
        }

        dense.Add((points[^1], total));
        static double Ease(double x) => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - (2 * x));
        var result = new List<Vec3>(dense.Count);
        for (var i = 0; i < dense.Count; i++)
        {
            var prev = i > 0 ? (dense[i].P - dense[i - 1].P).PlanarNormalized() : (dense[1].P - dense[0].P).PlanarNormalized();
            var next = i < dense.Count - 1 ? (dense[i + 1].P - dense[i].P).PlanarNormalized() : prev;
            var normal = (prev.RightNormal() + next.RightNormal()).PlanarNormalized();
            if (normal.PlanarLength < 1e-9)
            {
                normal = prev.RightNormal();
            }

            var shift = (start * Ease(1 - (dense[i].S / taper))) + (end * Ease(1 - ((total - dense[i].S) / taper)));
            result.Add(dense[i].P + (normal * shift));
        }

        return result;
    }

    /// <summary>Cubic Bézier between two lane ends, sampled into <paramref name="segments"/> pieces.</summary>
    public static IReadOnlyList<Vec3> Bezier(Vec3 start, Vec3 startDirection, Vec3 end, Vec3 endDirection, int segments = 8)
    {
        var distance = (end - start).PlanarLength / 3;
        var p1 = start + (startDirection * distance);
        var p2 = end - (endDirection * distance);
        var result = new List<Vec3>(segments + 1);
        for (var i = 0; i <= segments; i++)
        {
            var t = (double)i / segments;
            var m = 1 - t;
            result.Add((start * (m * m * m)) + (p1 * (3 * m * m * t)) + (p2 * (3 * m * t * t)) + (end * (t * t * t)));
        }

        return result;
    }

    /// <summary>True when the polylines cross in the horizontal plane (touching endpoints excluded).</summary>
    public static bool Crosses(IReadOnlyList<Vec3> a, IReadOnlyList<Vec3> b)
    {
        ArgumentNullException.ThrowIfNull(a);
        ArgumentNullException.ThrowIfNull(b);
        for (var i = 1; i < a.Count; i++)
        {
            for (var j = 1; j < b.Count; j++)
            {
                if (SegmentsCross(a[i - 1], a[i], b[j - 1], b[j]))
                {
                    return true;
                }
            }
        }

        return false;
    }

    internal static bool SegmentsCross(Vec3 p, Vec3 q, Vec3 r, Vec3 s)
    {
        var d = ((q.X - p.X) * (s.Y - r.Y)) - ((q.Y - p.Y) * (s.X - r.X));
        if (Math.Abs(d) < 1e-12)
        {
            return false;
        }

        var t = (((r.X - p.X) * (s.Y - r.Y)) - ((r.Y - p.Y) * (s.X - r.X))) / d;
        var u = (((r.X - p.X) * (q.Y - p.Y)) - ((r.Y - p.Y) * (q.X - p.X))) / d;
        const double eps = 1e-6;
        return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
    }

    /// <summary>Signed angle in degrees from direction <paramref name="a"/> to <paramref name="b"/>; positive = left turn.</summary>
    public static double SignedAngle(Vec3 a, Vec3 b)
    {
        var cross = (a.X * b.Y) - (a.Y * b.X);
        var dot = (a.X * b.X) + (a.Y * b.Y);
        return Math.Atan2(cross, dot) * 180 / Math.PI;
    }
}
