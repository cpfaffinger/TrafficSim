using TrafficSim.Domain.Geo;

namespace TrafficSim.Domain.Tests.Geo;

public class GeoPolygonTests
{
    // An L-shaped (concave) polygon around Vienna.
    private static readonly GeoPolygon L = new([
        new GeoPoint(48.20, 16.36), new GeoPoint(48.21, 16.36), new GeoPoint(48.21, 16.365),
        new GeoPoint(48.205, 16.365), new GeoPoint(48.205, 16.37), new GeoPoint(48.20, 16.37), new GeoPoint(48.20, 16.36),
    ]);

    [Fact]
    public void Normalises_ring_and_computes_bounds_and_area()
    {
        Assert.Equal(6, L.Ring.Count); // closing vertex dropped
        Assert.Equal(new BoundingBox(48.20, 16.36, 48.21, 16.37), L.Bounds);
        Assert.False(L.IsRectangle);
        var full = GeoPolygon.FromBoundingBox(L.Bounds);
        Assert.True(full.IsRectangle);
        Assert.InRange(L.AreaSquareKilometers / full.AreaSquareKilometers, 0.74, 0.76);
        Assert.Equal(L.Bounds.AreaSquareKilometers, full.AreaSquareKilometers, 1);
    }

    [Fact]
    public void Point_in_polygon_handles_concave_shapes()
    {
        Assert.True(L.Contains(new GeoPoint(48.202, 16.368)));
        Assert.True(L.Contains(new GeoPoint(48.208, 16.362)));
        Assert.False(L.Contains(new GeoPoint(48.208, 16.368))); // the notch
        Assert.False(L.Contains(new GeoPoint(48.3, 16.36)));
    }

    [Fact]
    public void Clockwise_rings_are_reversed_and_text_round_trips()
    {
        var cw = new GeoPolygon(L.Ring.Reverse());
        Assert.Equal(L, cw);
        Assert.Equal(L, GeoPolygon.Parse(L.ToString()));
        Assert.Equal(L.GetHashCode(), cw.GetHashCode());
        Assert.False(L.Equals((object?)null));
        Assert.Equal(L, new GeoPolygon(L.Ring.Select(p => new GeoPoint(p.Latitude + 1e-8, p.Longitude))).Normalize());
    }

    [Fact]
    public void Rejects_invalid_rings()
    {
        Assert.Throws<ArgumentException>(() => new GeoPolygon([new GeoPoint(0, 0), new GeoPoint(0, 1)]));
        Assert.Throws<ArgumentException>(() => new GeoPolygon([new GeoPoint(0, 0), new GeoPoint(0, 1), new GeoPoint(0, 2)]));
        Assert.Throws<ArgumentException>(() => new GeoPolygon([new GeoPoint(0, 0), new GeoPoint(1, 1), new GeoPoint(0, 1), new GeoPoint(1, 0)]));
        Assert.Throws<ArgumentException>(() => new GeoPolygon(Enumerable.Range(0, GeoPolygon.MaxVertices + 1)
            .Select(i => new GeoPoint(Math.Sin(i * 0.01), Math.Cos(i * 0.01)))));
    }
}
