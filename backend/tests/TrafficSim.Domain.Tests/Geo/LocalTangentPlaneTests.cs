using TrafficSim.Domain.Geo;

namespace TrafficSim.Domain.Tests.Geo;

public class LocalTangentPlaneTests
{
    private static readonly GeoPoint Vienna = new(48.2082, 16.3738);

    [Fact]
    public void Origin_maps_to_zero()
    {
        var plane = new LocalTangentPlane(Vienna);

        var local = plane.ToLocal(Vienna);

        Assert.Equal(0, local.East, precision: 9);
        Assert.Equal(0, local.North, precision: 9);
    }

    [Fact]
    public void Axes_point_east_and_north()
    {
        var plane = new LocalTangentPlane(Vienna);

        var northOfOrigin = plane.ToLocal(new GeoPoint(Vienna.Latitude + 0.01, Vienna.Longitude));
        var eastOfOrigin = plane.ToLocal(new GeoPoint(Vienna.Latitude, Vienna.Longitude + 0.01));

        Assert.True(northOfOrigin.North > 0);
        Assert.Equal(0, northOfOrigin.East, precision: 9);
        Assert.True(eastOfOrigin.East > 0);
        Assert.Equal(0, eastOfOrigin.North, precision: 9);
    }

    [Theory]
    [InlineData(0.01, 0)]
    [InlineData(0, 0.01)]
    [InlineData(0.05, 0.05)]
    [InlineData(-0.1, 0.12)]
    public void Local_distances_match_geodesic_distances_within_tolerance(double dLat, double dLon)
    {
        var plane = new LocalTangentPlane(Vienna);
        var target = new GeoPoint(Vienna.Latitude + dLat, Vienna.Longitude + dLon);

        var local = plane.ToLocal(target);
        var planar = Math.Sqrt((local.East * local.East) + (local.North * local.North));
        var spherical = GeoMath.HaversineDistanceMeters(Vienna, target);

        // Spherical haversine differs from the ellipsoid by up to ~0.5 %, so compare relatively.
        Assert.InRange(planar / spherical, 0.995, 1.005);
    }

    [Fact]
    public void Round_trip_is_exact_to_the_millimetre()
    {
        var plane = new LocalTangentPlane(Vienna);
        var original = new GeoPoint(48.25, 16.45);

        var back = plane.ToGeo(plane.ToLocal(original));

        Assert.True(GeoMath.HaversineDistanceMeters(original, back) < 0.001);
    }

    [Fact]
    public void One_kilometre_north_is_about_0_009_degrees_latitude()
    {
        var plane = new LocalTangentPlane(Vienna);

        var p = plane.ToGeo(new LocalPoint(0, 1000));

        Assert.InRange(p.Latitude - Vienna.Latitude, 0.00897, 0.00901);
    }
}
