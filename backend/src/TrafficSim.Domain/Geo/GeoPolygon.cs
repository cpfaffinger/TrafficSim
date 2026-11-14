namespace TrafficSim.Domain.Geo;

/// <summary>
/// A simple WGS84 polygon (one outer ring, no holes) used for non-rectangular import areas (#110).
/// The ring is stored open (first vertex not repeated) and counter-clockwise.
/// </summary>
public sealed class GeoPolygon : IEquatable<GeoPolygon>
{
    public const int MaxVertices = 500;

    public GeoPolygon(IEnumerable<GeoPoint> ring)
    {
        ArgumentNullException.ThrowIfNull(ring);
        var points = ring.ToList();
        if (points.Count > 1 && points[0] == points[^1])
        {
            points.RemoveAt(points.Count - 1);
        }

        points = points.Where((p, i) => i == 0 || p != points[i - 1]).ToList();
        if (points.Count < 3)
        {
            throw new ArgumentException("A polygon needs at least three distinct vertices.", nameof(ring));
        }

        if (points.Count > MaxVertices)
        {
            throw new ArgumentException($"A polygon may have at most {MaxVertices} vertices.", nameof(ring));
        }

        if (SignedArea(points) < 0)
        {
            points.Reverse();
        }

        if (Math.Abs(SignedArea(points)) < 1e-12)
        {
            throw new ArgumentException("The polygon has no area.", nameof(ring));
        }

        if (SelfIntersects(points))
        {
            throw new ArgumentException("The polygon must not intersect itself.", nameof(ring));
        }

        Ring = points;
        Bounds = new BoundingBox(points.Min(p => p.Latitude), points.Min(p => p.Longitude), points.Max(p => p.Latitude), points.Max(p => p.Longitude));
    }

    public IReadOnlyList<GeoPoint> Ring { get; }

    public BoundingBox Bounds { get; }

    public static GeoPolygon FromBoundingBox(BoundingBox box)
    {
        ArgumentNullException.ThrowIfNull(box);
        return new GeoPolygon([
            new GeoPoint(box.South, box.West), new GeoPoint(box.South, box.East),
            new GeoPoint(box.North, box.East), new GeoPoint(box.North, box.West),
        ]);
    }

    /// <summary>True when the polygon is exactly its bounding box.</summary>
    public bool IsRectangle => Ring.Count == 4 && Ring.All(p =>
        (p.Latitude == Bounds.South || p.Latitude == Bounds.North) && (p.Longitude == Bounds.West || p.Longitude == Bounds.East));

    /// <summary>Area in km², computed in a local tangent plane around the bounds centre.</summary>
    public double AreaSquareKilometers
    {
        get
        {
            var plane = new LocalTangentPlane(Bounds.Center);
            var local = Ring.Select(plane.ToLocal).ToList();
            var sum = 0.0;
            for (var i = 0; i < local.Count; i++)
            {
                var a = local[i];
                var b = local[(i + 1) % local.Count];
                sum += (a.East * b.North) - (b.East * a.North);
            }

            return Math.Abs(sum) / 2 / 1e6;
        }
    }

    public bool Contains(GeoPoint p)
    {
        var inside = false;
        for (int i = 0, j = Ring.Count - 1; i < Ring.Count; j = i++)
        {
            var (xi, yi) = (Ring[i].Longitude, Ring[i].Latitude);
            var (xj, yj) = (Ring[j].Longitude, Ring[j].Latitude);
            if ((yi > p.Latitude) != (yj > p.Latitude) && p.Longitude < ((xj - xi) * (p.Latitude - yi) / (yj - yi)) + xi)
            {
                inside = !inside;
            }
        }

        return inside;
    }

    /// <summary>Rounds vertices to 6 decimals (~0.1 m) so identical requests compare equal.</summary>
    public GeoPolygon Normalize() => new(Ring.Select(p => new GeoPoint(Math.Round(p.Latitude, 6), Math.Round(p.Longitude, 6))));

    /// <summary>Canonical text form "lat lon,lat lon,…" used for equality and storage.</summary>
    public override string ToString() => string.Join(',', Ring.Select(p =>
        FormattableString.Invariant($"{p.Latitude:R} {p.Longitude:R}")));

    public static GeoPolygon Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        return new GeoPolygon(text.Split(',').Select(pair =>
        {
            var parts = pair.Trim().Split(' ');
            return new GeoPoint(
                double.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture),
                double.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture));
        }));
    }

    public bool Equals(GeoPolygon? other) => other is not null && Ring.SequenceEqual(other.Ring);

    public override bool Equals(object? obj) => Equals(obj as GeoPolygon);

    public override int GetHashCode() => ToString().GetHashCode(StringComparison.Ordinal);

    private static double SignedArea(List<GeoPoint> p)
    {
        var sum = 0.0;
        for (var i = 0; i < p.Count; i++)
        {
            var a = p[i];
            var b = p[(i + 1) % p.Count];
            sum += (a.Longitude * b.Latitude) - (b.Longitude * a.Latitude);
        }

        return sum / 2;
    }

    private static bool SelfIntersects(List<GeoPoint> p)
    {
        var n = p.Count;
        for (var i = 0; i < n; i++)
        {
            for (var j = i + 1; j < n; j++)
            {
                if (Math.Abs(i - j) <= 1 || (i == 0 && j == n - 1))
                {
                    continue;
                }

                if (Cross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n]))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool Cross(GeoPoint a, GeoPoint b, GeoPoint c, GeoPoint d)
    {
        static double Orient(GeoPoint p, GeoPoint q, GeoPoint r) =>
            ((q.Longitude - p.Longitude) * (r.Latitude - p.Latitude)) - ((q.Latitude - p.Latitude) * (r.Longitude - p.Longitude));
        var o1 = Orient(a, b, c);
        var o2 = Orient(a, b, d);
        var o3 = Orient(c, d, a);
        var o4 = Orient(c, d, b);
        return o1 * o2 < 0 && o3 * o4 < 0;
    }
}
