using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Overpass;

namespace TrafficSim.Providers.Tests.Overpass;

public class OverpassPolygonQueryTests
{
    [Fact]
    public void Polygon_queries_use_the_poly_filter_and_rectangles_the_bbox()
    {
        var triangle = new GeoPolygon([new GeoPoint(48.2, 16.36), new GeoPoint(48.2, 16.37), new GeoPoint(48.21, 16.365)]);

        var query = OverpassQuery.Build(triangle, 60);

        Assert.Contains("(poly:\"48.2000000 16.3600000 48.2000000 16.3700000 48.2100000 16.3650000\")", query, StringComparison.Ordinal);
        Assert.Contains("(48.2000000,16.3600000,48.2100000,16.3700000)", OverpassQuery.Build(GeoPolygon.FromBoundingBox(triangle.Bounds), 60), StringComparison.Ordinal);
    }
}
