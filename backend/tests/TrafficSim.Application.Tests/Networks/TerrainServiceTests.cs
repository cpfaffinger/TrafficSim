using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using TrafficSim.Application.Networks;
using TrafficSim.Application.Providers;
using TrafficSim.Application.RoadSources;
using TrafficSim.Application.Scenarios;
using TrafficSim.Domain.Editing;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Network;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Tests.Networks;

/// <summary>Terrain sampling at import, the package key <c>terrain</c> and its reuse for edits (#87, ADR-0018).</summary>
public class TerrainServiceTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly BoundingBox Area = new(48.2, 16.36, 48.21, 16.375);

    /// <summary>Elevation source with heights from a function of (lat, lon), or a failure.</summary>
    private sealed class Elevation(Func<GeoPoint, double?> height, string name = "fake-dem", int priority = 1) : IElevationProvider
    {
        public Exception? Failure { get; init; }

        public int Calls { get; private set; }

        public string Name => name;

        public int Priority => priority;

        public string Attribution => $"Elevation by {name}";

        public Task<IReadOnlyList<double?>> SampleAsync(IReadOnlyList<GeoPoint> points, CancellationToken cancellationToken)
        {
            Calls++;
            if (Failure is not null)
            {
                throw Failure;
            }

            return Task.FromResult<IReadOnlyList<double?>>(points.Select(height).ToList());
        }
    }

    private sealed class Source : IRoadNetworkSource
    {
        public string Name => "fake-source";

        public int Priority => 1;

        public string Attribution => "Fake data";

        public double MaxAreaSquareKilometers => 50;

        public Task<OsmDataSet> FetchAsync(BoundingBox area, CancellationToken cancellationToken)
        {
            var c = area.Center;
            return Task.FromResult(new OsmDataSet(
                [new OsmNode(1, new GeoPoint(c.Latitude, c.Longitude - 0.004)), new OsmNode(2, new GeoPoint(c.Latitude, c.Longitude + 0.004))],
                [new OsmWay(10, [1, 2], OsmTags.Of(("highway", "primary")))],
                DateTimeOffset.UnixEpoch));
        }
    }

    /// <summary>Rises 5 m per 0.001° of longitude (≈ 6.7 % eastwards at 48.2°N) from 400 m at 16.3675°E.</summary>
    private static double? Slope(GeoPoint p) => 400 + ((p.Longitude - 16.3675) * 5000);

    private static TerrainService Service(params IElevationProvider[] providers) => new(providers, NullLogger<TerrainService>.Instance);

    [Fact]
    public void Layout_covers_the_area_with_a_margin_and_bounded_size()
    {
        var (west, south, cell, columns, rows) = TerrainService.Layout(Area);
        var plane = new LocalTangentPlane(Area.Center);
        var ne = plane.ToLocal(Area.NorthEast);

        Assert.Equal(TerrainService.MinCellMetres, cell);
        Assert.True(west < plane.ToLocal(Area.SouthWest).East && south < plane.ToLocal(Area.SouthWest).North);
        Assert.True(west + ((columns - 1) * cell) > ne.East && south + ((rows - 1) * cell) > ne.North);

        var large = TerrainService.Layout(new BoundingBox(47.5, 15.5, 48.0, 16.2));
        Assert.True(large.Columns <= TerrainService.MaxSamplesPerSide && large.Rows <= TerrainService.MaxSamplesPerSide);
        Assert.True(large.Cell > TerrainService.MinCellMetres);
    }

    [Fact]
    public void Build_makes_heights_relative_to_the_origin_and_fills_gaps()
    {
        var grid = TerrainService.Build(0, 0, 30, 2, 2, [410.04, null, 420, 430, 400]);

        Assert.NotNull(grid);
        Assert.Equal(400, grid.OriginElevation);
        Assert.Equal([10, 20, 20, 30], grid.Heights); // the gap gets the mean of the others, rounded to 0.1 m
        Assert.Null(TerrainService.Build(0, 0, 30, 2, 2, [null, null, null, null, 400]));
        Assert.Null(TerrainService.Build(0, 0, 30, 2, 2, [1, 2, 3]));
        Assert.Equal(-0.5, TerrainService.Build(0, 0, 30, 2, 2, [1, 2, 3, 4, null])!.Heights[1], 9); // origin falls back to the mean
    }

    [Fact]
    public async Task Samples_the_grid_relative_to_the_origin_ground()
    {
        var dem = new Elevation(Slope);

        var answer = await Service(dem).SampleAsync(GeoPolygon.FromBoundingBox(Area), Ct);

        Assert.NotNull(answer);
        Assert.Equal("fake-dem", answer.Provider);
        Assert.Equal(1, dem.Calls);
        var grid = answer.Grid;
        Assert.InRange(grid.OriginElevation, 399.9, 400.1);
        Assert.InRange(grid.HeightAt(0, 0), -0.2, 0.2);
        // 0.001° of longitude ≈ 74.2 m at 48.205°N.
        Assert.InRange(grid.HeightAt(371, 0) - grid.HeightAt(0, 0), 24.5, 25.5);
    }

    [Fact]
    public async Task Falls_back_to_the_next_provider_and_gives_up_quietly()
    {
        var down = new Elevation(Slope, "down", 1) { Failure = new ProviderUnavailableException("down", "HTTP 503") };
        var empty = new Elevation(_ => null, "empty", 2);
        var good = new Elevation(Slope, "good", 3);

        var answer = await Service(good, empty, down).SampleAsync(GeoPolygon.FromBoundingBox(Area), Ct);
        Assert.Equal("good", answer!.Provider);
        Assert.Equal(1, down.Calls);
        Assert.Equal(1, empty.Calls);

        Assert.Null(await Service(down, empty).SampleAsync(GeoPolygon.FromBoundingBox(Area), Ct));
        Assert.Null(await Service().SampleAsync(GeoPolygon.FromBoundingBox(Area), Ct));
    }

    private static (NetworkImportService Import, InMemoryNetworkBaselineStore Store) Import(TerrainService? terrain)
    {
        var store = new InMemoryNetworkBaselineStore();
        var service = new NetworkImportService(
            new RoadNetworkService([new Source()], NullLogger<RoadNetworkService>.Instance),
            store, new InMemoryImportJobStore(), new ChannelImportQueue(), TimeProvider.System, NullLogger<NetworkImportService>.Instance,
            terrain: terrain);
        return (service, store);
    }

    private static async Task<(NetworkBaselineInfo Info, NetworkPackage Package)> RunImportAsync(NetworkImportService import, InMemoryNetworkBaselineStore store)
    {
        var job = await import.StartAsync(Area, Ct);
        await import.RunAsync(job.Id, Ct);
        var done = await import.GetJobAsync(job.Id, Ct);
        Assert.Equal(ImportStatus.Completed, done!.Status);
        var info = (await store.GetAsync(done.BaselineId!.Value, Ct))!;
        return (info, NetworkPackageWriter.DeserializeGzip((await store.GetPackageAsync(info.Id, Ct))!));
    }

    [Fact]
    public async Task Import_places_the_network_on_the_terrain_and_credits_the_source()
    {
        var (import, store) = Import(Service(new Elevation(Slope)));

        var (info, package) = await RunImportAsync(import, store);

        Assert.Contains("Elevation by fake-dem", info.Attribution);
        Assert.NotNull(package.Terrain);
        Assert.Equal(package.Terrain.Columns * package.Terrain.Rows, package.Terrain.Heights.Count);
        var east = package.Links.Single(l => l.Geometry[0][0] < l.Geometry[^1][0]);
        Assert.InRange(east.Geometry[^1][2] - east.Geometry[0][2], 35, 45); // ≈ 594 m at 6.7 %
        Assert.Contains(package.Nodes, n => n.Z > 15);
    }

    [Fact]
    public async Task Import_without_elevation_data_stays_flat()
    {
        var failing = new Elevation(Slope) { Failure = new ProviderUnavailableException("fake-dem", "timeout") };
        var (import, store) = Import(Service(failing));

        var (info, package) = await RunImportAsync(import, store);

        Assert.Null(package.Terrain);
        Assert.DoesNotContain("Elevation by fake-dem", info.Attribution);
        Assert.All(package.Nodes, n => Assert.Equal(0, n.Z));
    }

    [Fact]
    public async Task Edits_reuse_the_baseline_terrain()
    {
        var dem = new Elevation(Slope);
        var (import, store) = Import(Service(dem));
        var (info, package) = await RunImportAsync(import, store);
        var scenarios = new ScenarioService(store, new InMemoryScenarioStore(), new InMemoryRunStore(), TimeProvider.System);

        var edited = await scenarios.CompileAsync(info.Id, [new SetWayTags(10, null, null, new Dictionary<string, string?> { ["lanes"] = "4" })], Ct);

        var recompiled = NetworkPackageWriter.DeserializeGzip(edited.GzipPackage);
        Assert.Equal(1, dem.Calls);
        Assert.Equal(package.Terrain!.Heights, recompiled.Terrain!.Heights);
        Assert.Equal(package.Nodes.Select(n => n.Z), recompiled.Nodes.Select(n => n.Z));
    }

    [Fact]
    public void Package_terrain_round_trips_and_serialises_camel_case()
    {
        var grid = new TerrainGrid(-45.12345, -30, 30, 2, 2, [0, 1.26, -2, 3], 512.34);
        var dto = PackageTerrain.From(grid)!;

        Assert.Equal(-45.123, dto.West);
        Assert.Equal(1.3, dto.Heights[1]);
        Assert.Equal(512.3, dto.OriginElevation);
        Assert.Null(PackageTerrain.From(null));
        Assert.Equal(2, dto.ToGrid()!.Columns);
        Assert.Null((dto with { Heights = [1, 2] }).ToGrid());

        var json = JsonSerializer.Serialize(dto, NetworkPackage.JsonOptions);
        Assert.Contains("\"cellSize\":30", json, StringComparison.Ordinal);
        Assert.Contains("\"originElevation\":512.3", json, StringComparison.Ordinal);
    }
}
