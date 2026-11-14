using TrafficSim.Domain.Network;
using TrafficSim.Domain.Network.Compilation;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Domain.Tests.Network;

public class LaneLayoutRuleTests
{
    private static LaneLayout Resolve(string highway, params (string, string)[] tags)
    {
        RoadClasses.TryParse(highway, out var c);
        return LaneLayoutRule.Resolve(OsmTags.Of(tags), c);
    }

    [Theory]
    [InlineData("residential", "", "", "", "", "No", 1, 1, true)]
    [InlineData("primary", "4", "", "", "", "No", 2, 2, false)]
    [InlineData("primary", "3", "", "", "", "No", 2, 1, true)]
    [InlineData("primary", "3", "2", "", "", "No", 2, 1, false)]
    [InlineData("primary", "3", "", "2", "", "No", 1, 2, false)]
    [InlineData("primary", "", "2", "1", "", "No", 2, 1, false)]
    [InlineData("primary", "2", "", "", "yes", "Forward", 2, 0, false)]
    [InlineData("primary", "2", "", "", "-1", "Backward", 0, 2, false)]
    [InlineData("motorway", "", "", "", "", "Forward", 2, 0, true)]
    [InlineData("motorway", "", "", "", "no", "No", 1, 1, true)]
    [InlineData("residential", "1", "", "", "", "No", 1, 1, true)]
    [InlineData("primary", "20", "", "", "yes", "Forward", 8, 0, false)]
    public void Interprets_lane_tags(string highway, string lanes, string fw, string bw, string oneway, string expectedOneWay, int expectedFw, int expectedBw, bool assumed)
    {
        var tags = new List<(string, string)>();
        if (lanes.Length > 0)
        {
            tags.Add(("lanes", lanes));
        }

        if (fw.Length > 0)
        {
            tags.Add(("lanes:forward", fw));
        }

        if (bw.Length > 0)
        {
            tags.Add(("lanes:backward", bw));
        }

        if (oneway.Length > 0)
        {
            tags.Add(("oneway", oneway));
        }

        var layout = Resolve(highway, [.. tags]);

        Assert.Equal(Enum.Parse<OneWay>(expectedOneWay), layout.OneWay);
        Assert.Equal(expectedFw, layout.Forward);
        Assert.Equal(expectedBw, layout.Backward);
        Assert.Equal(assumed, layout.Assumed);
    }

    [Fact]
    public void Roundabouts_are_implicitly_one_way() =>
        Assert.Equal(OneWay.Forward, Resolve("secondary", ("junction", "roundabout")).OneWay);

    [Fact]
    public void Turn_lanes_define_the_count_when_lanes_is_missing()
    {
        var layout = Resolve("primary", ("oneway", "yes"), ("turn:lanes", "left|through|through;right"));

        Assert.Equal(3, layout.Forward);
        Assert.False(layout.Assumed);
        Assert.Equal(2, Resolve("primary", ("turn:lanes:forward", "left|through"), ("turn:lanes:backward", "through")).Forward);
    }

    [Fact]
    public void Both_ways_centre_lane_is_subtracted()
    {
        var layout = Resolve("primary", ("lanes", "5"), ("lanes:both_ways", "1"));

        Assert.Equal((2, 2, 1), (layout.Forward, layout.Backward, layout.BothWays));
        Assert.Equal(2, layout.For(TravelDirection.Backward));
    }
}

public class TurnLanesParserTests
{
    [Theory]
    [InlineData("left", TurnMarkings.Left)]
    [InlineData("through;right", TurnMarkings.Through | TurnMarkings.Right)]
    [InlineData("slight_left;sharp_right", TurnMarkings.SlightLeft | TurnMarkings.SharpRight)]
    [InlineData("reverse;merge_to_left;merge_to_right", TurnMarkings.Reverse | TurnMarkings.MergeToLeft | TurnMarkings.MergeToRight)]
    [InlineData("slight_right;sharp_left", TurnMarkings.SlightRight | TurnMarkings.SharpLeft)]
    [InlineData("", TurnMarkings.None)]
    [InlineData("none", TurnMarkings.None)]
    [InlineData(null, TurnMarkings.None)]
    public void Parses_lane_values(string? value, TurnMarkings expected) => Assert.Equal(expected, TurnLanesParser.ParseLane(value));

    [Theory]
    [InlineData(0, Turn.Through)]
    [InlineData(30, Turn.SlightLeft)]
    [InlineData(-30, Turn.SlightRight)]
    [InlineData(90, Turn.Left)]
    [InlineData(-90, Turn.Right)]
    [InlineData(150, Turn.SharpLeft)]
    [InlineData(-150, Turn.SharpRight)]
    [InlineData(179, Turn.Reverse)]
    public void Classifies_turn_angles(double angle, Turn expected) => Assert.Equal(expected, TurnLanesParser.Classify(angle));

    [Fact]
    public void Lane_values_are_reversed_to_rightmost_first()
    {
        var tags = OsmTags.Of(("turn:lanes", "left|through|right"));

        var lanes = Tags.GetLanes(tags, "turn", TravelDirection.Forward, OneWay.Forward, 3);

        Assert.Equal(["right", "through", "left"], lanes);
        Assert.Null(Tags.GetLanes(tags, "turn", TravelDirection.Forward, OneWay.Forward, 2));
        Assert.Null(Tags.GetLanes(tags, "turn", TravelDirection.Forward, OneWay.No, 3));
    }

    [Fact]
    public void Every_turn_has_compatible_markings()
    {
        foreach (var turn in Enum.GetValues<Turn>())
        {
            Assert.NotEmpty(TurnLanesParser.Compatible(turn));
        }
    }
}

public class SpeedLimitParserTests
{
    [Theory]
    [InlineData("50", 50.0)]
    [InlineData("30 mph", 48.28)]
    [InlineData("100 km/h", 100.0)]
    [InlineData("10 knots", 18.52)]
    [InlineData("walk", 7.0)]
    [InlineData("none", 130.0)]
    [InlineData("DE:urban", 50.0)]
    [InlineData("DE:rural", 100.0)]
    [InlineData("AT:motorway", 130.0)]
    [InlineData("CH:rural", 80.0)]
    [InlineData("DE:zone30", 30.0)]
    [InlineData("DE:zone:20", 20.0)]
    [InlineData("DE:living_street", 7.0)]
    [InlineData("DE:trunk", 100.0)]
    [InlineData("DE:bicycle_road", 30.0)]
    [InlineData("XX:rural", 100.0)]
    [InlineData("signals", null)]
    [InlineData("fast", null)]
    [InlineData("50 furlongs", null)]
    [InlineData("", null)]
    public void Parses_values_to_kmh(string value, double? expected)
    {
        var kmh = SpeedLimitParser.ParseKmh(value);

        if (expected is null)
        {
            Assert.Null(kmh);
        }
        else
        {
            Assert.Equal(expected.Value, kmh!.Value, 2);
        }
    }

    [Fact]
    public void Directional_values_win_and_defaults_are_flagged()
    {
        var tags = OsmTags.Of(("maxspeed", "50"), ("maxspeed:backward", "30"));

        Assert.Equal((50 / 3.6, false), SpeedLimitParser.ForWay(tags, RoadClass.Primary, TravelDirection.Forward));
        Assert.Equal(30 / 3.6, SpeedLimitParser.ForWay(tags, RoadClass.Primary, TravelDirection.Backward).Ms, 6);
        var (ms, assumed) = SpeedLimitParser.ForWay(OsmTags.Empty, RoadClass.Motorway, TravelDirection.Forward);
        Assert.True(assumed);
        Assert.Equal(130 / 3.6, ms, 6);
        Assert.Equal(30 / 3.6, SpeedLimitParser.ForWay(OsmTags.Of(("zone:maxspeed", "DE:30")), RoadClass.Residential, TravelDirection.Forward).Ms, 6);
    }
}

public class AccessRuleTests
{
    [Fact]
    public void Default_allows_all_motor_vehicles() =>
        Assert.Equal((VehicleClasses.All, true), AccessRule.ForWay(OsmTags.Empty, RoadClass.Primary));

    [Fact]
    public void Restrictions_remove_classes()
    {
        Assert.Equal(VehicleClasses.None, AccessRule.ForWay(OsmTags.Of(("motor_vehicle", "no")), RoadClass.Primary).Allowed);
        Assert.Equal(VehicleClasses.Bus, AccessRule.ForWay(OsmTags.Of(("access", "no"), ("bus", "yes")), RoadClass.Primary).Allowed);
        Assert.False(AccessRule.ForWay(OsmTags.Of(("access", "destination")), RoadClass.Residential).ThroughTraffic);
        Assert.Equal(VehicleClasses.All & ~VehicleClasses.Truck, AccessRule.ForWay(OsmTags.Of(("hgv", "no")), RoadClass.Primary).Allowed);
        Assert.Equal(VehicleClasses.Truck | VehicleClasses.Bus | VehicleClasses.Motorcycle, AccessRule.ForWay(OsmTags.Of(("motorcar", "no")), RoadClass.Primary).Allowed);
        Assert.Equal(VehicleClasses.All & ~VehicleClasses.Motorcycle, AccessRule.ForWay(OsmTags.Of(("motorcycle", "no")), RoadClass.Primary).Allowed);
        Assert.Equal(VehicleClasses.All & ~VehicleClasses.Bus, AccessRule.ForWay(OsmTags.Of(("psv", "no")), RoadClass.Primary).Allowed);
        Assert.Equal(VehicleClasses.Bus, AccessRule.ForWay(OsmTags.Empty, RoadClass.Busway).Allowed);
    }

    [Fact]
    public void Lane_restrictions()
    {
        Assert.Equal(VehicleClasses.Bus, AccessRule.ForLane(VehicleClasses.All, "designated", null, null));
        Assert.Equal(VehicleClasses.All & ~VehicleClasses.Bus, AccessRule.ForLane(VehicleClasses.All, "no", null, null));
        Assert.Equal(VehicleClasses.All & ~VehicleClasses.Truck, AccessRule.ForLane(VehicleClasses.All, null, "no", null));
        Assert.Equal(VehicleClasses.None, AccessRule.ForLane(VehicleClasses.All, null, null, "no"));
        Assert.Equal(VehicleClasses.All, AccessRule.ForLane(VehicleClasses.All, "yes", null, null));
    }
}

public class LaneChangeRuleTests
{
    [Fact]
    public void Default_boundaries_are_dashed()
    {
        var b = Assert.Single(LaneChangeRule.Boundaries(null, null, 2));

        Assert.Equal(LaneMarking.Dashed, b.Marking);
        Assert.Equal(1, b.LeftLane);
    }

    [Fact]
    public void Change_lanes_produces_asymmetric_markings()
    {
        // OSM left to right: "not_right|yes|no" → rightmost first: no, yes, not_right
        var perLane = Tags.GetLanes(OsmTags.Of(("change:lanes", "not_right|yes|no")), "change", TravelDirection.Forward, OneWay.Forward, 3);

        var boundaries = LaneChangeRule.Boundaries(perLane, null, 3);

        // between lane 0 (no) and lane 1 (yes): lane 0 may not go left, lane 1 may go right
        Assert.Equal(LaneMarking.DashedSolid, boundaries[0].Marking);
        // between lane 1 (yes) and lane 2 (not_right): lane 1 may go left, lane 2 may not go right
        Assert.Equal(LaneMarking.SolidDashed, boundaries[1].Marking);
    }

    [Fact]
    public void General_change_no_makes_solid_lines()
    {
        Assert.All(LaneChangeRule.Boundaries(null, "no", 3), b => Assert.Equal(LaneMarking.Solid, b.Marking));
        Assert.True(LaneChangeRule.MayChangeLeft("only_left"));
        Assert.True(LaneChangeRule.MayChangeRight("only_right"));
    }

    [Theory]
    [InlineData("yes", 2, 2, null, "Edge")]
    [InlineData("no", 1, 1, null, "CentreDashed")]
    [InlineData("no", 2, 2, null, "CentreSolid")]
    [InlineData("no", 1, 1, "overtaking=no", "CentreSolid")]
    [InlineData("no", 2, 2, "overtaking=yes", "CentreDashed")]
    [InlineData("no", 1, 1, "divider=solid_line", "CentreSolid")]
    [InlineData("no", 1, 1, "divider=physical", "DoubleSolid")]
    [InlineData("no", 2, 2, "divider=dashed_line", "CentreDashed")]
    public void Centre_lines(string oneway, int fw, int bw, string? tag, string expected)
    {
        var tags = new List<(string, string)> { ("oneway", oneway) };
        if (tag is not null)
        {
            var parts = tag.Split('=');
            tags.Add((parts[0], parts[1]));
        }

        var edge = LaneChangeRule.LeftEdge(OsmTags.Of([.. tags]), LaneLayoutRule.ParseOneWay(OsmTags.Of([.. tags]), RoadClass.Primary), TravelDirection.Forward, fw, bw);

        Assert.Equal(Enum.Parse<EdgeMarking>(expected), edge);
    }
}

public class GradeSeparationRuleTests
{
    [Theory]
    [InlineData("bridge=yes", 1, Structure.Bridge)]
    [InlineData("bridge=viaduct;layer=2", 2, Structure.Bridge)]
    [InlineData("tunnel=yes", -1, Structure.Tunnel)]
    [InlineData("tunnel=building_passage", 0, Structure.Covered)]
    [InlineData("covered=yes", 0, Structure.Covered)]
    [InlineData("layer=-2", -2, Structure.None)]
    [InlineData("bridge=no", 0, Structure.None)]
    [InlineData("layer=9", 5, Structure.None)]
    public void Parses_structure_and_layer(string tagList, int layer, Structure structure)
    {
        var tags = OsmTags.Of(tagList.Split(';').Select(t => t.Split('=')).Select(p => (p[0], p[1])).ToArray());

        Assert.Equal((layer, structure), GradeSeparationRule.Parse(tags));
    }

    [Fact]
    public void Node_level_is_the_layer_closest_to_ground()
    {
        Assert.Equal(0, GradeSeparationRule.NodeLevel([1, 0]));
        Assert.Equal(1, GradeSeparationRule.NodeLevel([1, 2]));
        Assert.Equal(-1, GradeSeparationRule.NodeLevel([-1, -2]));
        Assert.Equal(0, GradeSeparationRule.NodeLevel([]));
        Assert.Equal(12, GradeSeparationRule.Elevation(2));
        Assert.Equal(-8, GradeSeparationRule.Elevation(-1));
    }

    [Fact]
    public void Profile_ramps_up_to_the_layer_and_back()
    {
        Assert.Equal(0, GradeSeparationRule.Profile(0, 200, 0, 0, 6), 6);
        Assert.Equal(6, GradeSeparationRule.Profile(100, 200, 0, 0, 6), 6);
        Assert.Equal(0, GradeSeparationRule.Profile(200, 200, 0, 0, 6), 6);
        Assert.InRange(GradeSeparationRule.Profile(40, 200, 0, 0, 6), 0.1, 5.9);
        Assert.Equal(3, GradeSeparationRule.Profile(0, 0, 3, 0, 6));
    }
}
