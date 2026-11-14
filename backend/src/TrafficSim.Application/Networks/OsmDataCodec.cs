using System.IO.Compression;
using System.Text.Json;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Networks;

/// <summary>Compact gzip JSON encoding of the raw OSM data kept with a baseline (needed to re-apply changesets).</summary>
public static class OsmDataCodec
{
    private sealed record Doc(DateTimeOffset? Timestamp, List<NodeDoc> Nodes, List<WayDoc> Ways, List<RelationDoc>? Relations = null);

    private sealed record NodeDoc(long Id, double Lat, double Lon, Dictionary<string, string>? Tags);

    private sealed record WayDoc(long Id, List<long> Nodes, Dictionary<string, string> Tags);

    /// <summary>A relation (#85); members as <c>[type, ref, role]</c> with type n/w/r.</summary>
    private sealed record RelationDoc(long Id, List<MemberDoc> Members, Dictionary<string, string> Tags);

    private sealed record MemberDoc(char Type, long Ref, string Role);

    public static byte[] Encode(OsmDataSet data)
    {
        ArgumentNullException.ThrowIfNull(data);
        var doc = new Doc(
            data.DataTimestamp,
            data.Nodes.Values.OrderBy(n => n.Id).Select(n => new NodeDoc(n.Id, n.Location.Latitude, n.Location.Longitude, n.Tags.Count == 0 ? null : n.Tags.ToDictionary())).ToList(),
            data.Ways.Select(w => new WayDoc(w.Id, w.NodeIds.ToList(), w.Tags.ToDictionary())).ToList(),
            data.Relations.Count == 0 ? null : data.Relations.Select(r => new RelationDoc(
                r.Id, r.Members.Select(m => new MemberDoc(TypeCode(m.Type), m.Ref, m.Role)).ToList(), r.Tags.ToDictionary())).ToList());
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
            doc.Timestamp,
            doc.Relations?.Select(r => new OsmRelation(
                r.Id,
                r.Members.Select(m => new OsmMember(MemberType(m.Type), m.Ref, m.Role)).ToList(),
                new Dictionary<string, string>(r.Tags, StringComparer.Ordinal))));
    }

    private static char TypeCode(OsmMemberType type) => type switch
    {
        OsmMemberType.Node => 'n',
        OsmMemberType.Way => 'w',
        _ => 'r',
    };

    private static OsmMemberType MemberType(char code) => code switch
    {
        'n' => OsmMemberType.Node,
        'w' => OsmMemberType.Way,
        _ => OsmMemberType.Relation,
    };
}
