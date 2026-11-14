using TrafficSim.Domain.Geo;

namespace TrafficSim.Domain.Tests.Geo;

public class GeoPointTests
{
    [Theory]
    [InlineData(0, 0)]
    [InlineData(-90, -180)]
    [InlineData(90, 180)]
    [InlineData(48.2082, 16.3738)]
    public void Accepts_valid_coordinates(double lat, double lon)
    {
        var p = new GeoPoint(lat, lon);

        Assert.Equal(lat, p.Latitude);
        Assert.Equal(lon, p.Longitude);
    }

    [Theory]
    [InlineData(-90.0001, 0)]
    [InlineData(90.0001, 0)]
    [InlineData(double.NaN, 0)]
    public void Rejects_invalid_latitude(double lat, double lon) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new GeoPoint(lat, lon));

    [Theory]
    [InlineData(0, -180.0001)]
    [InlineData(0, 180.0001)]
    [InlineData(0, double.NaN)]
    public void Rejects_invalid_longitude(double lat, double lon) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new GeoPoint(lat, lon));

    [Fact]
    public void ToString_uses_invariant_culture() =>
        Assert.Equal("(48.208200, 16.373800)", new GeoPoint(48.2082, 16.3738).ToString());
}
