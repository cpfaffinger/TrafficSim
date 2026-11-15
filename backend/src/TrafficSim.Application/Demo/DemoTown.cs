using TrafficSim.Application.Networks;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Network.Compilation;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Demo;

/// <summary>
/// A small synthetic town for the demo (#145), compiled from OSM-like data with the import compiler: a main
/// road with a signalised junction, a signalised pedestrian crossing and a zebra crossing, two side streets
/// with give-way signs, a T-junction and a grid of residential streets behind them. Not a real place.
/// </summary>
public static class DemoTown
{
    public const string Attribution = "Synthetic demo town (not a real place)";

    /// <summary>Somewhere without a town around it, so the basemap does not contradict the streets.</summary>
    public static readonly GeoPoint Origin = new(47.05, 14.55);

    private const double HalfWidth = 700;
    private const double HalfHeight = 600;

    private static readonly Lazy<byte[]> Package = new(() => NetworkPackageWriter.SerializeGzip(Build()));

    /// <summary>The demo network package, gzip-compressed JSON (built once).</summary>
    public static byte[] GzipPackage => Package.Value;

    public static NetworkPackage Build()
    {
        var network = NetworkCompiler.Compile(OsmData(), Area());
        return NetworkPackageWriter.ToPackage(network, null, [Attribution]);
    }

    public static BoundingBox Area()
    {
        var plane = new LocalTangentPlane(Origin);
        var sw = plane.ToGeo(new LocalPoint(-HalfWidth, -HalfHeight));
        var ne = plane.ToGeo(new LocalPoint(HalfWidth, HalfHeight));
        return new BoundingBox(sw.Latitude, sw.Longitude, ne.Latitude, ne.Longitude);
    }

    public static OsmDataSet OsmData()
    {
        var plane = new LocalTangentPlane(Origin);
        var nodes = new List<OsmNode>();
        var ways = new List<OsmWay>();
        void Node(long id, double x, double y, params (string, string)[] tags) =>
            nodes.Add(new OsmNode(id, plane.ToGeo(new LocalPoint(x, y)), OsmTags.Of(tags)));
        void Way(long id, long[] refs, params (string, string)[] tags) => ways.Add(new OsmWay(id, refs, OsmTags.Of(tags)));

        // Main road (west - east), two lanes per direction.
        Node(1, -800, 0);
        Node(2, -250, 0, ("highway", "traffic_signals"));
        Node(3, -120, 0, ("highway", "crossing"), ("crossing", "zebra"));
        Node(4, 0, 0);
        Node(5, 110, 0, ("highway", "crossing"), ("crossing", "traffic_signals"));
        Node(6, 250, 0);
        Node(7, 800, 0);
        Way(100, [1, 2, 3, 4, 5, 6, 7], ("highway", "primary"), ("name", "Hauptstraße"), ("lanes", "4"), ("maxspeed", "50"));

        // Station street (signalised junction with the main road).
        Node(10, -250, -700);
        Node(13, -250, -250);
        Node(11, -250, 220);
        Node(12, -250, 700);
        Way(101, [10, 13, 2, 11, 12], ("highway", "secondary"), ("name", "Bahnhofstraße"), ("lanes", "2"), ("maxspeed", "50"));

        // Church lane: gives way to the main road on both sides.
        Node(20, 250, -700);
        Node(25, 250, -250);
        Node(23, 250, -20, ("highway", "give_way"));
        Node(24, 250, 20, ("highway", "give_way"));
        Node(21, 250, 220);
        Node(22, 250, 700);
        Way(102, [20, 25, 23, 6, 24, 21, 22], ("highway", "residential"), ("name", "Kirchengasse"), ("maxspeed", "30"));

        // Market lane: T-junction north of the main road.
        Node(31, 0, 20, ("highway", "give_way"));
        Node(30, 0, 220);
        Way(103, [4, 31, 30], ("highway", "residential"), ("name", "Marktgasse"), ("maxspeed", "30"));

        // Residential streets behind the main road (priority to the right).
        Way(104, [11, 30, 21], ("highway", "residential"), ("name", "Schulweg"), ("maxspeed", "30"));
        Node(40, 0, -250);
        Way(105, [13, 40, 25], ("highway", "residential"), ("name", "Gartenweg"), ("maxspeed", "30"));
        Node(41, 0, -450);
        Way(106, [40, 41], ("highway", "residential"), ("name", "Wiesenweg"), ("maxspeed", "30"), ("noexit", "yes"));

        return new OsmDataSet(nodes, ways, null, []);
    }
}
