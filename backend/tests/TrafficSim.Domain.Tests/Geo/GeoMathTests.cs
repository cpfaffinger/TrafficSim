using TrafficSim.Domain.Geo;

namespace TrafficSim.Domain.Tests.Geo;

public class GeoMathTests
{
    [Fact]
    public void Distance_to_itself_is_zero()
    {
        var p = new GeoPoint(48.2, 16.37);

        Assert.Equal(0, GeoMath.HaversineDistanceMeters(p, p), precision: 6);
    }

    [Fact]
    public void One_degree_of_latitude_is_about_111_km()
    {
        var d = GeoMath.HaversineDistanceMeters(new GeoPoint(0, 0), new GeoPoint(1, 0));

        Assert.InRange(d, 111_100, 111_250);
    }

    [Fact]
    public void Vienna_to_Munich_is_about_355_km()
    {
        var vienna = new GeoPoint(48.2082, 16.3738);
        var munich = new GeoPoint(48.1351, 11.5820);

        var d = GeoMath.HaversineDistanceMeters(vienna, munich);

        Assert.InRange(d, 350_000, 360_000);
    }

    [Fact]
    public void Distance_is_symmetric()
    {
        var a = new GeoPoint(52.52, 13.405);
        var b = new GeoPoint(53.55, 9.993);

        Assert.Equal(GeoMath.HaversineDistanceMeters(a, b), GeoMath.HaversineDistanceMeters(b, a), precision: 6);
    }

    [Fact]
    public void Degree_radian_round_trip() =>
        Assert.Equal(123.456, GeoMath.RadiansToDegrees(GeoMath.DegreesToRadians(123.456)), precision: 10);
}
