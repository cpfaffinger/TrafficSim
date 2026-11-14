using OsmSharp;
using OsmSharp.Streams;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;
using TrafficSim.Providers.Overpass;

namespace TrafficSim.Providers.Geofabrik;

/// <summary>
/// Extracts the drivable road network of an area from an OSM PBF file in a single streaming pass
/// (PBF stores nodes before ways). Node positions within the area plus a margin are kept as compact
/// fixed-point values; ways with at least one node inside the area are kept, trimmed to known nodes.
/// </summary>
internal static class PbfRoadReader
{
    private const double FixedPoint = 1e7;
    private static readonly System.Text.RegularExpressions.Regex Highway = new(OverpassQuery.HighwayPattern, System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    private static readonly System.Text.RegularExpressions.Regex ExcludedService = new(OverpassQuery.ExcludedServicePattern, System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    public static OsmDataSet Read(Stream pbf, BoundingBox area, double marginMetres, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(area);
        var outer = Expand(area, marginMetres);
        var positions = new Dictionary<long, (int Lat, int Lon)>();
        var nodeTags = new Dictionary<long, IReadOnlyDictionary<string, string>>();
        var ways = new List<OsmWay>();
        var count = 0;

        foreach (var element in new PBFOsmStreamSource(pbf))
        {
            if (++count % 100_000 == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }

            switch (element)
            {
                case Node { Id: { } id, Latitude: { } lat, Longitude: { } lon } node when outer.Contains(new GeoPoint(lat, lon)):
                    positions[id] = ((int)Math.Round(lat * FixedPoint), (int)Math.Round(lon * FixedPoint));
                    if (node.Tags is { Count: > 0 })
                    {
                        nodeTags[id] = ToDictionary(node.Tags);
                    }

                    break;
                case Way { Id: { } id, Nodes: { Length: >= 2 } refs, Tags: { } tags } when IsRoad(tags) && refs.Any(r => IsInside(positions, r, area)):
                    ways.Add(new OsmWay(id, refs.Where(positions.ContainsKey).ToList(), ToDictionary(tags)));
                    break;
            }
        }

        var used = ways.SelectMany(w => w.NodeIds).ToHashSet();
        var nodes = used.Select(id =>
        {
            var (lat, lon) = positions[id];
            return new OsmNode(id, new GeoPoint(lat / FixedPoint, lon / FixedPoint), nodeTags.GetValueOrDefault(id, OsmTags.Empty));
        });
        return new OsmDataSet(nodes, ways);
    }

    internal static BoundingBox Expand(BoundingBox area, double metres)
    {
        var dLat = metres / 111_320.0;
        var dLon = metres / (111_320.0 * Math.Cos(area.Center.Latitude * Math.PI / 180));
        return new BoundingBox(
            Math.Max(-90, area.South - dLat), Math.Max(-180, area.West - dLon),
            Math.Min(90, area.North + dLat), Math.Min(180, area.East + dLon));
    }

    private static bool IsRoad(OsmSharp.Tags.TagsCollectionBase tags) =>
        tags.TryGetValue("highway", out var highway) && Highway.IsMatch(highway)
        && !(tags.TryGetValue("service", out var service) && ExcludedService.IsMatch(service))
        && !(tags.TryGetValue("area", out var isArea) && isArea == "yes");

    private static bool IsInside(Dictionary<long, (int Lat, int Lon)> positions, long id, BoundingBox area) =>
        positions.TryGetValue(id, out var p) && area.Contains(new GeoPoint(p.Lat / FixedPoint, p.Lon / FixedPoint));

    private static Dictionary<string, string> ToDictionary(OsmSharp.Tags.TagsCollectionBase tags)
    {
        var dict = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var tag in tags)
        {
            dict[tag.Key] = tag.Value;
        }

        return dict;
    }
}
