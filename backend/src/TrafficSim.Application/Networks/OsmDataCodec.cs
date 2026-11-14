using System.IO.Compression;
using System.Text.Json;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Networks;

/// <summary>Compact gzip JSON encoding of the raw OSM data kept with a baseline (needed to re-apply changesets).</summary>
public static class OsmDataCodec
{
    private sealed record Doc(DateTimeOffset? Timestamp, List<NodeDoc> Nodes, List<WayDoc> Ways);

    private sealed record NodeDoc(long Id, double Lat, double Lon, Dictionary<string, string>? Tags);

    private sealed record WayDoc(long Id, List<long> Nodes, Dictionary<string, string> Tags);

    public static byte[] Encode(OsmDataSet data)
    {
        ArgumentNullException.ThrowIfNull(data);
        var doc = new Doc(
            data.DataTimestamp,
            data.Nodes.Values.OrderBy(n => n.Id).Select(n => new NodeDoc(n.Id, n.Location.Latitude, n.Location.Longitude, n.Tags.Count == 0 ? null : n.Tags.ToDictionary())).ToList(),
            data.Ways.Select(w => new WayDoc(w.Id, w.NodeIds.ToList(), w.Tags.ToDictionary())).ToList());
        using var buffer = new MemoryStream();
        using (var gzip = new GZipStream(buffer, CompressionLevel.Optimal, leaveOpen: true))
        {
            JsonSerializer.Serialize(gzip, doc, JsonSerializerOptions.Web);
        }

        return buffer.ToArray();
    }

    public static OsmDataSet Decode(byte[] gzipJson)
    {
        using var input = new GZipStream(new MemoryStream(gzipJson), CompressionMode.Decompress);
        var doc = JsonSerializer.Deserialize<Doc>(input, JsonSerializerOptions.Web) ?? throw new JsonException("empty OSM data");
        return new OsmDataSet(
            doc.Nodes.Select(n => new OsmNode(n.Id, new GeoPoint(n.Lat, n.Lon), n.Tags is null ? OsmTags.Empty : new Dictionary<string, string>(n.Tags, StringComparer.Ordinal))),
            doc.Ways.Select(w => new OsmWay(w.Id, w.Nodes, new Dictionary<string, string>(w.Tags, StringComparer.Ordinal))),
            doc.Timestamp);
    }
}
