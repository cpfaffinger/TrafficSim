using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Network;
using TrafficSim.Domain.Network.Compilation;

namespace TrafficSim.Domain.Tests.Network;

public class PolygonClipTests
{
    [Fact]
    public void Ways_are_clipped_at_a_concave_polygon_edge()
    {
        var plane = new LocalTangentPlane(OsmBuilder.Origin);
        GeoPoint G(double x, double y) => plane.ToGeo(new LocalPoint(x, y));
        // L-shape: missing the north-east quadrant
        var polygon = new GeoPolygon([G(-200, -200), G(200, -200), G(200, 0), G(0, 0), G(0, 200), G(-200, 200)]);
        var b = new OsmBuilder()
            .Node(1, -300, 100).Node(2, 300, 100)    // east-west road through the notch at y = 100
            .Node(3, -300, -100).Node(4, 300, -100) // road inside the lower part
            .Way(10, [1, 2], ("highway", "primary"))
            .Way(11, [3, 4], ("highway", "primary"));

        var net = NetworkCompiler.Compile(b.Build(), polygon);

        Assert.Equal(polygon, net.Polygon);
        Assert.Equal(4, net.Links.Count);
        var upper = net.Links.Where(l => l.OsmWayId == 10).ToList();
        Assert.All(upper, l => Assert.All(l.Geometry, p => Assert.InRange(p.X, -201, 1)));
        var lower = net.Links.Where(l => l.OsmWayId == 11).ToList();
        Assert.All(lower, l => Assert.InRange(Polyline.PlanarLength(l.Geometry), 399, 401));
        Assert.Equal(4, net.Nodes.Count(n => n.Control == NodeControl.Boundary));
        Assert.Null(NetworkCompiler.Compile(b.Build(), b.Area()).Polygon);
    }

    [Fact]
    public void A_segment_crossing_the_whole_area_without_inner_vertices_is_kept()
    {
        var b = new OsmBuilder().Node(1, -500, 10).Node(2, 500, 10).Way(10, [1, 2], ("highway", "primary"));

        var net = NetworkCompiler.Compile(b.Build(), b.Area(100));

        Assert.Equal(2, net.Links.Count);
        Assert.All(net.Links, l => Assert.InRange(Polyline.PlanarLength(l.Geometry), 199, 201));
    }
}
