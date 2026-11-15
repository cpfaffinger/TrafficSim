using TrafficSim.Domain.Network;
using TrafficSim.Domain.Network.Compilation;

namespace TrafficSim.Domain.Tests.Network;

/// <summary>Terrain grid sampling and the elevation rule of the compiler (#87, ADR-0018).</summary>
public class TerrainTests
{
    /// <summary>A grid over ±500 m with 25 m cells whose heights come from <paramref name="height"/>.</summary>
    private static TerrainGrid Grid(Func<double, double, double> height, double cell = 25, double half = 500)
    {
        var n = (int)(2 * half / cell) + 1;
        var heights = new double[n * n];
        for (var r = 0; r < n; r++)
        {
            for (var c = 0; c < n; c++)
            {
                heights[(r * n) + c] = height(-half + (c * cell), -half + (r * cell));
            }
        }

        return new TerrainGrid(-half, -half, cell, n, n, heights, 312.5);
    }

    private static RoadNetwork Compile(OsmBuilder b, TerrainGrid? terrain) =>
        NetworkCompiler.Compile(b.Build(), b.Area(), new CompilerOptions { Terrain = terrain });

    private static double MaxGrade(IReadOnlyList<Vec3> points) =>
        points.Zip(points.Skip(1), (a, b) => Math.Abs(b.Z - a.Z) / Math.Max((b - a).PlanarLength, 1e-9)).Max();

    [Fact]
    public void Grid_interpolates_bilinearly_and_clamps_outside()
    {
        var grid = new TerrainGrid(-10, 0, 10, 2, 2, [0, 10, 20, 30]);

        Assert.Equal(0, grid.HeightAt(-10, 0));
        Assert.Equal(30, grid.HeightAt(0, 10));
        Assert.Equal(15, grid.HeightAt(-5, 5), 9);
        Assert.Equal(5, grid.HeightAt(-5, -100), 9); // clamped to the south edge
        Assert.Equal(30, grid.HeightAt(1000, 1000));
        Assert.Equal(0, grid.East);
        Assert.Equal(10, grid.North);
    }

    [Fact]
    public void Grid_rejects_inconsistent_input()
    {
        Assert.Throws<ArgumentException>(() => new TerrainGrid(0, 0, 10, 2, 2, [0, 1, 2]));
        Assert.Throws<ArgumentException>(() => new TerrainGrid(0, 0, 10, 2, 2, [0, 1, 2, double.NaN]));
        Assert.Throws<ArgumentOutOfRangeException>(() => new TerrainGrid(0, 0, 0, 2, 2, [0, 1, 2, 3]));
        Assert.Throws<ArgumentOutOfRangeException>(() => new TerrainGrid(0, 0, 10, 1, 4, [0, 1, 2, 3]));
    }

    [Fact]
    public void Without_terrain_the_rule_is_the_grade_separation_profile()
    {
        IReadOnlyList<Vec3> line = [new(0, 0), new(100, 0)];

        var expected = GradeSeparationRule.Apply(line, 0, 0, 6);
        var actual = ElevationRule.Apply(line, 0, 0, 6, terrain: null, followsTerrain: false);

        Assert.Equal(expected, actual);
        Assert.Equal(0, ElevationRule.Ground(null, new Vec3(5, 5)));
    }

    [Fact]
    public void Road_on_a_slope_climbs_with_the_terrain_and_stays_continuous()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, 0, 0).Node(3, 200, 0).Node(4, 0, 200)
            .Way(10, [1, 2, 3], ("highway", "primary"))
            .Way(11, [2, 4], ("highway", "residential"));
        var net = Compile(b, Grid((x, _) => 0.06 * x));

        Assert.NotNull(net.Terrain);
        Assert.Equal(-12, net.Nodes.Single(n => n.OsmId == 1).Position.Z, 1);
        Assert.Equal(12, net.Nodes.Single(n => n.OsmId == 3).Position.Z, 1);
        var eastNode = net.Nodes.Single(n => n.OsmId == 3);
        var east = net.Links.Single(l => l.To == eastNode.Id);
        var lane = east.Lanes[0].Geometry;
        Assert.True(lane.Count > 10, "resampled every 10 m");
        foreach (var (a, c) in lane.Zip(lane.Skip(1)))
        {
            Assert.Equal(0.06, (c.Z - a.Z) / (c - a).PlanarLength, 3);
        }

        // Connectors join lane ends at their heights.
        foreach (var conn in net.Connectors)
        {
            var from = net.Links.Single(l => l.Id == conn.FromLink).Lanes[conn.FromLane].Geometry[^1];
            var to = net.Links.Single(l => l.Id == conn.ToLink).Lanes[conn.ToLane].Geometry[0];
            Assert.Equal(from.Z, conn.Geometry[0].Z, 9);
            Assert.Equal(to.Z, conn.Geometry[^1].Z, 9);
        }

        // Link ends at plain joints and boundaries sit on their node.
        var westNode = net.Nodes.Single(n => n.OsmId == 1);
        var westbound = net.Links.Single(l => l.To == westNode.Id);
        Assert.Equal(westNode.Position.Z, westbound.Geometry[^1].Z, 9);
    }

    [Fact]
    public void Flat_terrain_gives_the_same_heights_as_no_terrain()
    {
        var b = new OsmBuilder()
            .Node(1, -200, 50).Node(2, -60, 50).Node(3, 60, 50).Node(4, 200, 50)
            .Way(20, [1, 2], ("highway", "motorway"))
            .Way(21, [2, 3], ("highway", "motorway"), ("bridge", "yes"), ("layer", "1"))
            .Way(22, [3, 4], ("highway", "motorway"));
        var flat = Compile(b, Grid((_, _) => 0));
        var none = Compile(b, null);

        foreach (var link in none.Links)
        {
            var other = flat.Links.Single(l => l.Id == link.Id);
            foreach (var d in new[] { 0.0, 13, 40, link.Length / 2, link.Length })
            {
                Assert.Equal(Polyline.PointAt(link.Geometry, d).Z, Polyline.PointAt(other.Geometry, d).Z, 6);
            }
        }

        Assert.Null(none.Terrain);
    }

    [Fact]
    public void Bridge_deck_spans_a_valley_instead_of_following_it()
    {
        // A 40 m deep valley along x = 0 between two plateaus at ±60 m.
        var valley = Grid((x, _) => Math.Abs(x) < 60 ? -40 + (Math.Abs(x) * 40 / 60) : 0, cell: 20);
        var b = new OsmBuilder()
            .Node(1, -200, 0).Node(2, -60, 0).Node(3, 60, 0).Node(4, 200, 0)
            .Way(20, [1, 2], ("highway", "primary"), ("oneway", "yes"))
            .Way(21, [2, 3], ("highway", "primary"), ("oneway", "yes"), ("bridge", "yes"))
            .Way(22, [3, 4], ("highway", "primary"), ("oneway", "yes"));
        var net = Compile(b, valley);

        var bridge = net.Links.Single(l => l.OsmWayId == 21);
        var mid = Polyline.PointAt(bridge.Geometry, Polyline.PlanarLength(bridge.Geometry) / 2);
        // Level with its abutments (0 m): no road passes beneath, so it is not raised (#157).
        Assert.InRange(mid.Z, -0.5, 0.5);
        Assert.All(bridge.Geometry, p => Assert.True(p.Z > -0.01, $"deck dips to {p.Z}"));
        // The approach roads follow the plateau.
        Assert.All(net.Links.Single(l => l.OsmWayId == 20).Geometry, p => Assert.InRange(p.Z, -3, 0.01));
    }

    [Fact]
    public void Tunnel_runs_straight_under_a_hill()
    {
        var hill = Grid((x, _) => Math.Max(0, 80 - Math.Abs(x)));
        var b = new OsmBuilder()
            .Node(1, -150, 0).Node(2, 150, 0)
            .Way(20, [1, 2], ("highway", "primary"), ("oneway", "yes"), ("tunnel", "yes"));
        var net = Compile(b, hill);

        var tunnel = Assert.Single(net.Links);
        Assert.All(tunnel.Geometry, p => Assert.True(p.Z <= 0.01, $"tunnel climbs to {p.Z}"));
        Assert.InRange(Polyline.PointAt(tunnel.Geometry, 150).Z, -8.01, -7.99);
    }

    [Fact]
    public void Dem_noise_is_smoothed_out_of_road_grades()
    {
        // ±1.5 m checkerboard noise on a 25 m grid would give grades of ~12 % between samples.
        var noisy = Grid((x, y) => ((int)Math.Round((x + y) / 25) % 2 == 0) ? 1.5 : -1.5);
        var b = new OsmBuilder()
            .Node(1, -250, 3).Node(2, 250, 3)
            .Way(20, [1, 2], ("highway", "primary"));
        var net = Compile(b, noisy);

        Assert.All(net.Links, l => Assert.True(MaxGrade(l.Geometry) < 0.08, $"grade {MaxGrade(l.Geometry)}"));
    }
}
