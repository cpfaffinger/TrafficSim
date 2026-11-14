using TrafficSim.Domain.Geo;

namespace TrafficSim.Domain.Osm;

/// <summary>An OSM node with its position and tags (canonical, source independent).</summary>
public sealed record OsmNode(long Id, GeoPoint Location, IReadOnlyDictionary<string, string> Tags)
{
    public OsmNode(long id, GeoPoint location)
        : this(id, location, OsmTags.Empty)
    {
    }
}

/// <summary>An OSM way: ordered node references and tags.</summary>
public sealed record OsmWay(long Id, IReadOnlyList<long> NodeIds, IReadOnlyDictionary<string, string> Tags);

/// <summary>Type of an OSM relation member.</summary>
public enum OsmMemberType
{
    Node,
    Way,
    Relation,
}

/// <summary>A member reference of an OSM relation with its role (e.g. <c>stop</c>, <c>platform</c>, empty).</summary>
public sealed record OsmMember(OsmMemberType Type, long Ref, string Role);

/// <summary>An OSM relation (public transport routes, #85): ordered members and tags.</summary>
public sealed record OsmRelation(long Id, IReadOnlyList<OsmMember> Members, IReadOnlyDictionary<string, string> Tags);

/// <summary>Helpers for OSM tag dictionaries.</summary>
public static class OsmTags
{
    public static IReadOnlyDictionary<string, string> Empty { get; } = new Dictionary<string, string>(StringComparer.Ordinal);

    public static IReadOnlyDictionary<string, string> Of(params (string Key, string Value)[] tags)
    {
        ArgumentNullException.ThrowIfNull(tags);
        return tags.ToDictionary(t => t.Key, t => t.Value, StringComparer.Ordinal);
    }
}

/// <summary>
/// Raw OSM road data for an area as delivered by a road network source. Ways keep only node
/// references that resolve to a node in <see cref="Nodes"/>; ways with fewer than two are dropped.
/// </summary>
public sealed class OsmDataSet
{
    public OsmDataSet(IEnumerable<OsmNode> nodes, IEnumerable<OsmWay> ways, DateTimeOffset? dataTimestamp = null, IEnumerable<OsmRelation>? relations = null)
    {
        ArgumentNullException.ThrowIfNull(nodes);
        ArgumentNullException.ThrowIfNull(ways);
        var nodeMap = new Dictionary<long, OsmNode>();
        foreach (var node in nodes)
        {
            nodeMap[node.Id] = node;
        }

        Nodes = nodeMap;
        Ways = ways
            .Select(w => w.NodeIds.All(nodeMap.ContainsKey) ? w : w with { NodeIds = w.NodeIds.Where(nodeMap.ContainsKey).ToList() })
            .Where(w => w.NodeIds.Count >= 2)
            .ToList();
        DataTimestamp = dataTimestamp;
        Relations = relations?.ToList() ?? [];
    }

    public IReadOnlyDictionary<long, OsmNode> Nodes { get; }

    public IReadOnlyList<OsmWay> Ways { get; }

    /// <summary>
    /// Relations delivered with the roads (bus and trolleybus routes and their route masters, #85).
    /// Members may reference elements outside the data set (routes leave the area).
    /// </summary>
    public IReadOnlyList<OsmRelation> Relations { get; }

    /// <summary>OSM replication timestamp of the data, when the source reports it.</summary>
    public DateTimeOffset? DataTimestamp { get; }
}
