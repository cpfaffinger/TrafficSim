using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;
using TrafficSim.Providers.Overpass;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.Overpass;

public class OverpassTransitTests
{
    private static readonly BoundingBox Area = new(48.2000, 16.3600, 48.2050, 16.3700);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static OverpassRoadNetworkSource Create(StubHttpMessageHandler handler) =>
        new(ProviderFactory.Client(handler, "https://overpass.test/api/"), ProviderFactory.Options(o =>
        {
            o.Overpass.BaseUrl = new Uri("https://overpass.test/api/");
            o.Overpass.Mirrors.Clear();
        }));

    [Fact]
    public async Task Maps_route_relations_with_ordered_members_and_roles()
    {
        var handler = StubHttpMessageHandler.Json(Fixtures.Read("overpass", "bus-route.json"));

        var data = await Create(handler).FetchAsync(Area, Ct);

        Assert.Equal(2, data.Relations.Count);
        var route = data.Relations[0];
        Assert.Equal(401, route.Id);
        Assert.Equal("59A", route.Tags["ref"]);
        Assert.Equal(
            [
                new OsmMember(OsmMemberType.Node, 102, "stop"),
                new OsmMember(OsmMemberType.Node, 201, "platform"),
                new OsmMember(OsmMemberType.Way, 300, string.Empty),
                new OsmMember(OsmMemberType.Way, 301, string.Empty),
                new OsmMember(OsmMemberType.Way, 302, string.Empty),
            ],
            route.Members);
        var master = data.Relations[1];
        Assert.Equal(new OsmMember(OsmMemberType.Relation, 401, string.Empty), Assert.Single(master.Members));
        Assert.Equal("yes", data.Nodes[201].Tags["bus_bay"]);
    }

    [Fact]
    public void Queries_bus_routes_of_the_roads_with_member_nodes_in_the_area()
    {
        var query = OverpassQuery.Build(Area, 90);

        Assert.Contains("(._;>;);out body qt;rel(bw)[\"type\"=\"route\"][\"route\"~\"^(bus|trolleybus)$\"]->.lines;", query, StringComparison.Ordinal);
        Assert.Contains("node(r.lines)(48.2000000,16.3600000,48.2050000,16.3700000);out body qt;", query, StringComparison.Ordinal);
        Assert.EndsWith(".lines out body qt;rel(br.lines)[\"type\"=\"route_master\"];out body qt;", query, StringComparison.Ordinal);

        var triangle = new GeoPolygon([new GeoPoint(48.2, 16.36), new GeoPoint(48.2, 16.37), new GeoPoint(48.21, 16.365)]);
        Assert.Contains("node(r.lines)(poly:\"48.2000000 16.3600000", OverpassQuery.Build(triangle, 60), StringComparison.Ordinal);
    }
}
