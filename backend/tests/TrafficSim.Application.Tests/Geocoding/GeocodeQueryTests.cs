using TrafficSim.Application.Geocoding;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Application.Tests.Geocoding;

public class GeocodeQueryTests
{
    [Fact]
    public void Trims_text_and_normalises_language()
    {
        var q = new GeocodeQuery("  Karlsplatz ", 3, " DE ", new GeoPoint(48.2, 16.37));

        Assert.Equal("Karlsplatz", q.Text);
        Assert.Equal(3, q.Limit);
        Assert.Equal("de", q.Language);
        Assert.NotNull(q.Bias);
    }

    [Fact]
    public void Blank_language_becomes_null() =>
        Assert.Null(new GeocodeQuery("x", language: "  ").Language);

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Rejects_empty_text(string text) =>
        Assert.Throws<ArgumentException>(() => new GeocodeQuery(text));

    [Fact]
    public void Rejects_too_long_text() =>
        Assert.Throws<ArgumentException>(() => new GeocodeQuery(new string('a', GeocodeQuery.MaxTextLength + 1)));

    [Theory]
    [InlineData(0)]
    [InlineData(GeocodeQuery.MaxLimit + 1)]
    public void Rejects_limit_out_of_range(int limit) =>
        Assert.Throws<ArgumentOutOfRangeException>(() => new GeocodeQuery("x", limit));
}
