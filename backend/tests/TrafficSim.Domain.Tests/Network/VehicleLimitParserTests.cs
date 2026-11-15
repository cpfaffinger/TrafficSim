using TrafficSim.Domain.Network;
using TrafficSim.Domain.Network.Compilation;

namespace TrafficSim.Domain.Tests.Network;

public class VehicleLimitParserTests
{
    [Theory]
    [InlineData("3.5", 3.5)]
    [InlineData("3.5 m", 3.5)]
    [InlineData("3,8", 3.8)]
    [InlineData("12'6\"", 3.81)]
    [InlineData("13'", 3.96)]
    [InlineData("10 ft", 3.05)]
    [InlineData("none", null)]
    [InlineData("default", null)]
    [InlineData("below_default", null)]
    [InlineData("", null)]
    public void Parses_metres(string value, double? expected) => Assert.Equal(expected, VehicleLimitParser.ParseMetres(value));

    [Theory]
    [InlineData("7.5", 7.5)]
    [InlineData("7.5 t", 7.5)]
    [InlineData("3500 kg", 3.5)]
    [InlineData("20000 lbs", 9.07)]
    [InlineData("unsigned", null)]
    public void Parses_tonnes(string value, double? expected) => Assert.Equal(expected, VehicleLimitParser.ParseTonnes(value));

    [Fact]
    public void Directional_and_physical_values_take_the_stricter_limit()
    {
        var tags = new Dictionary<string, string>
        {
            ["maxheight"] = "4",
            ["maxheight:physical"] = "3.6",
            ["maxlength:forward"] = "10",
            ["maxweight"] = "7.5",
        };

        var forward = VehicleLimitParser.ForWay(tags, TravelDirection.Forward)!;
        var backward = VehicleLimitParser.ForWay(tags, TravelDirection.Backward)!;

        Assert.Equal(new VehicleLimits(10, null, 3.6, 7.5), forward);
        Assert.Equal(new VehicleLimits(null, null, 3.6, 7.5), backward);
        Assert.Null(VehicleLimitParser.ForWay(new Dictionary<string, string> { ["highway"] = "primary" }, TravelDirection.Forward));
    }
}
