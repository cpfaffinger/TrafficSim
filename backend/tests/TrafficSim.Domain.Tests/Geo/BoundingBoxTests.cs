using TrafficSim.Domain.Geo;

namespace TrafficSim.Domain.Tests.Geo;

public class BoundingBoxTests
{
    [Fact]
    public void Exposes_edges_and_center()
    {
        var box = new BoundingBox(48.0, 16.0, 48.2, 16.4);

        Assert.Equal(48.0, box.South);
        Assert.Equal(16.0, box.West);
        Assert.Equal(48.2, box.North);
        Assert.Equal(16.4, box.East);
        Assert.Equal(48.1, box.Center.Latitude, precision: 10);
        Assert.Equal(16.2, box.Center.Longitude, precision: 10);
    }

    [Theory]
    [InlineData(48.2, 16.0, 48.0, 16.4)] // south > north
    [InlineData(48.0, 16.0, 48.0, 16.4)] // zero height
    [InlineData(48.0, 16.4, 48.2, 16.0)] // west > east
    public void Rejects_degenerate_or_inverted_boxes(double s, double w, double n, double e) =>
        Assert.Throws<ArgumentException>(() => new BoundingBox(s, w, n, e));

    [Fact]
    public void Rejects_out_of_range_coordinates() =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new BoundingBox(-91, 0, 0, 1));

    [Fact]
    public void Area_of_one_degree_square_at_equator_is_about_12364_km2()
    {
        var box = new BoundingBox(0, 0, 1, 1);

        Assert.InRange(box.AreaSquareKilometers, 12_300, 12_400);
    }

    [Fact]
    public void Area_shrinks_towards_the_poles()
    {
        var equator = new BoundingBox(0, 0, 0.1, 0.1);
        var north = new BoundingBox(60, 0, 60.1, 0.1);

        Assert.InRange(north.AreaSquareKilometers / equator.AreaSquareKilometers, 0.49, 0.51);
    }

    [Fact]
    public void Contains_includes_edges_and_excludes_outside_points()
    {
        var box = new BoundingBox(48.0, 16.0, 48.2, 16.4);

        Assert.True(box.Contains(new GeoPoint(48.1, 16.2)));
        Assert.True(box.Contains(new GeoPoint(48.0, 16.0)));
        Assert.False(box.Contains(new GeoPoint(47.99, 16.2)));
        Assert.False(box.Contains(new GeoPoint(48.1, 16.41)));
    }
}
