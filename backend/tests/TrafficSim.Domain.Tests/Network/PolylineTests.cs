using TrafficSim.Domain.Network;

namespace TrafficSim.Domain.Tests.Network;

public class PolylineTests
{
    private static readonly IReadOnlyList<Vec3> L = [new(0, 0), new(10, 0), new(10, 10)];

    [Fact]
    public void Length_point_at_and_slice()
    {
        Assert.Equal(20, Polyline.Length(L), 9);
        Assert.Equal(new Vec3(10, 5), Polyline.PointAt(L, 15));
        Assert.Equal(L[0], Polyline.PointAt(L, -1));
        Assert.Equal(L[^1], Polyline.PointAt(L, 99));
        var slice = Polyline.Slice(L, 5, 15);
        Assert.Equal([new Vec3(5, 0), new Vec3(10, 0), new Vec3(10, 5)], slice);
    }

    [Fact]
    public void Offset_moves_to_the_right_with_miter()
    {
        var right = Polyline.Offset(L, 1);

        Assert.Equal(new Vec3(0, -1), right[0]);
        Assert.Equal(11, right[1].X, 9);
        Assert.Equal(-1, right[1].Y, 9);
        Assert.Equal(new Vec3(11, 10), right[2]);
        Assert.Same(L, L);
        Assert.Equal(L, Polyline.Offset(L, 0));
    }

    [Fact]
    public void Directions_angles_and_crossings()
    {
        Assert.Equal(new Vec3(1, 0), Polyline.Direction(L, atEnd: false));
        Assert.Equal(new Vec3(0, 1), Polyline.Direction(L, atEnd: true));
        Assert.Equal(90, Polyline.SignedAngle(new Vec3(1, 0), new Vec3(0, 1)), 9);
        Assert.Equal(-90, Polyline.SignedAngle(new Vec3(1, 0), new Vec3(0, -1)), 9);
        Assert.True(Polyline.Crosses([new(-1, 0), new(1, 0)], [new(0, -1), new(0, 1)]));
        Assert.False(Polyline.Crosses([new(-1, 0), new(1, 0)], [new(-1, 1), new(1, 1)]));
        Assert.False(Polyline.Crosses([new(0, 0), new(1, 0)], [new(1, 0), new(2, 1)]));
    }

    [Fact]
    public void Bezier_connects_endpoints()
    {
        var curve = Polyline.Bezier(new Vec3(0, 0), new Vec3(1, 0), new Vec3(10, 10), new Vec3(0, 1));

        Assert.Equal(9, curve.Count);
        Assert.Equal(new Vec3(0, 0), curve[0]);
        Assert.Equal(10, curve[^1].X, 9);
        Assert.Equal(10, curve[^1].Y, 9);
    }

    [Fact]
    public void Vector_helpers()
    {
        var v = new Vec3(3, 4, 12);
        Assert.Equal(13, v.Length, 9);
        Assert.Equal(5, v.PlanarLength, 9);
        Assert.Equal(new Vec3(0, 0), new Vec3(0, 0).PlanarNormalized());
        Assert.Equal(new Vec3(4, 6, 12), Vec3.Add(v, new Vec3(1, 2)));
        Assert.Equal(new Vec3(2, 2, 12), Vec3.Subtract(v, new Vec3(1, 2)));
        Assert.Equal(new Vec3(6, 8, 24), Vec3.Multiply(v, 2));
        Assert.Equal(new Vec3(0, -1), new Vec3(1, 0).RightNormal());
    }
}
