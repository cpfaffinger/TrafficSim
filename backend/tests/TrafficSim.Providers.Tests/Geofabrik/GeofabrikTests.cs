using OsmSharp;
using OsmSharp.Streams;
using OsmSharp.Tags;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Geofabrik;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.Geofabrik;

public class GeofabrikTests
{
    private static readonly BoundingBox Vienna = new(48.20, 16.36, 48.21, 16.38);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public void Index_selects_smallest_covering_region()
    {
        using var stream = File.OpenRead(Fixtures.Path("geofabrik", "index-v1.json"));
        var regions = GeofabrikIndex.Parse(stream);

        Assert.Equal(["europe", "austria", "broken-geometry-skipped"], regions.Select(r => r.Id).Take(3));
        Assert.Equal("austria", GeofabrikIndex.Select(regions, Vienna)!.Id);
        Assert.Equal("europe", GeofabrikIndex.Select(regions, new BoundingBox(50.0, 2.0, 50.1, 2.1))!.Id);
        Assert.Null(GeofabrikIndex.Select(regions, new BoundingBox(-10, -10, -9, -9)));
    }

    [Fact]
    public void Index_without_features_is_invalid()
    {
        using var stream = new MemoryStream("{}"u8.ToArray());

        Assert.Throws<System.Text.Json.JsonException>(() => GeofabrikIndex.Parse(stream));
    }

    [Fact]
    public void Pbf_reader_keeps_roads_touching_the_area_with_margin_nodes()
    {
        using var pbf = BuildPbf();

        var data = PbfRoadReader.Read(pbf, Vienna, 1000, Ct);

        // way 1 inside, way 2 crosses the border (node 3 in the margin), way 3 is a footway, way 4 is far away
        Assert.Equal([1L, 2L], data.Ways.Select(w => w.Id).Order());
        Assert.Equal([2L, 3L], data.Ways.Single(w => w.Id == 2).NodeIds);
        Assert.Equal("traffic_signals", data.Nodes[2].Tags["highway"]);
        Assert.Equal(48.2050001, data.Nodes[1].Location.Latitude, 7);
        Assert.False(data.Nodes.ContainsKey(5));
        // bus route 10 uses way 1 (with platform node 7), its route master 12; the tram route is dropped
        Assert.Equal([10L, 12L], data.Relations.Select(r => r.Id));
        Assert.Equal(new TrafficSim.Domain.Osm.OsmMember(TrafficSim.Domain.Osm.OsmMemberType.Node, 7, "platform"), data.Relations[0].Members[0]);
        Assert.Equal("bus_stop", data.Nodes[7].Tags["highway"]);
    }

    [Fact]
    public async Task Source_downloads_index_and_extract_once_and_reads_roads()
    {
        using var dir = new TempDirectory();
        using var pbf = BuildPbf();
        var pbfBytes = pbf.ToArray();
        var index = await File.ReadAllBytesAsync(Fixtures.Path("geofabrik", "index-v1.json"), Ct);
        var handler = new StubHttpMessageHandler(r => new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new ByteArrayContent(r.RequestUri!.AbsolutePath.EndsWith(".pbf", StringComparison.Ordinal) ? pbfBytes : index),
        });
        var source = new GeofabrikRoadNetworkSource(
            ProviderFactory.Client(handler, "https://geofabrik.test/"),
            ProviderFactory.Options(o => o.Geofabrik.Directory = dir.Path),
            TimeProvider.System);

        var first = await source.FetchAsync(Vienna, Ct);
        var second = await source.FetchAsync(Vienna, Ct);

        Assert.Equal(2, first.Ways.Count);
        Assert.Equal(2, second.Ways.Count);
        Assert.Equal(["/index-v1.json", "/europe/austria-latest.osm.pbf"], handler.Requests.Select(r => r.RequestUri!.AbsolutePath));
        Assert.True(File.Exists(Path.Combine(dir.Path, "austria.osm.pbf")));
        Assert.Equal("geofabrik", source.Name);
        Assert.Equal(2500, source.MaxAreaSquareKilometers);
        Assert.Equal(50, source.Priority);
        Assert.Contains("Geofabrik", source.Attribution, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Area_outside_every_region_is_unavailable()
    {
        using var dir = new TempDirectory();
        var handler = StubHttpMessageHandler.Json(Fixtures.Read("geofabrik", "index-v1.json"));
        var source = new GeofabrikRoadNetworkSource(
            ProviderFactory.Client(handler, "https://geofabrik.test/"),
            ProviderFactory.Options(o => o.Geofabrik.Directory = dir.Path),
            TimeProvider.System);

        await Assert.ThrowsAsync<ProviderUnavailableException>(() => source.FetchAsync(new BoundingBox(-10, -10, -9, -9), Ct));
    }

    [Fact]
    public void File_names_are_sanitised() =>
        Assert.Equal("us_california.osm.pbf", GeofabrikRoadNetworkSource.FileNameFor(new GeofabrikRegion("us/california", "California", new Uri("https://x.test/a.pbf"), [])));

    private static MemoryStream BuildPbf()
    {
        var stream = new MemoryStream();
        var target = new PBFOsmStreamTarget(stream, compress: false);
        target.Initialize();
        target.AddNode(Node(1, 48.2050001, 16.3700));
        target.AddNode(Node(2, 48.2060, 16.3750, new Tag("highway", "traffic_signals")));
        target.AddNode(Node(3, 48.2150, 16.3750)); // 0.5 km north of the area, inside the margin
        target.AddNode(Node(4, 48.2070, 16.3710));
        target.AddNode(Node(5, 47.0000, 15.0000));
        target.AddNode(Node(6, 47.0010, 15.0010));
        target.AddNode(Node(7, 48.2051, 16.3701, new Tag("highway", "bus_stop")));
        target.AddWay(Way(1, [1, 2], new Tag("highway", "primary")));
        target.AddWay(Way(2, [2, 3], new Tag("highway", "residential"), new Tag("bridge", "yes"), new Tag("layer", "1")));
        target.AddWay(Way(3, [1, 4], new Tag("highway", "footway")));
        target.AddWay(Way(4, [5, 6], new Tag("highway", "primary")));
        target.AddRelation(Relation(10, [new RelationMember(7, "platform", OsmGeoType.Node), new RelationMember(1, string.Empty, OsmGeoType.Way)], new Tag("type", "route"), new Tag("route", "bus")));
        target.AddRelation(Relation(11, [new RelationMember(1, string.Empty, OsmGeoType.Way)], new Tag("type", "route"), new Tag("route", "tram")));
        target.AddRelation(Relation(12, [new RelationMember(10, string.Empty, OsmGeoType.Relation)], new Tag("type", "route_master")));
        target.AddRelation(Relation(13, [new RelationMember(99, string.Empty, OsmGeoType.Relation)], new Tag("type", "route_master")));
        target.Flush();
        target.Close();
        return new MemoryStream(stream.ToArray());
    }

    private static Node Node(long id, double lat, double lon, params Tag[] tags) => new()
    {
        Id = id, Latitude = lat, Longitude = lon, Tags = new TagsCollection(tags),
        Version = 1, ChangeSetId = 1, TimeStamp = DateTime.UnixEpoch, UserId = 1, UserName = "t", Visible = true,
    };

    private static Relation Relation(long id, RelationMember[] members, params Tag[] tags) => new()
    {
        Id = id, Members = members, Tags = new TagsCollection(tags),
        Version = 1, ChangeSetId = 1, TimeStamp = DateTime.UnixEpoch, UserId = 1, UserName = "t", Visible = true,
    };

    private static Way Way(long id, long[] nodes, params Tag[] tags) => new()
    {
        Id = id, Nodes = nodes, Tags = new TagsCollection(tags),
        Version = 1, ChangeSetId = 1, TimeStamp = DateTime.UnixEpoch, UserId = 1, UserName = "t", Visible = true,
    };
}
