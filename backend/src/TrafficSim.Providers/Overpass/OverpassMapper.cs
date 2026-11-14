using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Providers.Overpass;

/// <summary>Translates Overpass JSON into the canonical <see cref="OsmDataSet"/> (anti-corruption layer).</summary>
internal static class OverpassMapper
{
    public static OsmDataSet Map(OverpassResponse? response)
    {
        if (response?.Elements is null)
        {
            throw new ProviderUnavailableException(OverpassRoadNetworkSource.ProviderName, "response without elements");
        }

        // Overpass reports server-side timeouts and memory exhaustion as a remark with partial data.
        if (response.Remark is { } remark && remark.Contains("runtime error", StringComparison.OrdinalIgnoreCase))
        {
            throw new ProviderUnavailableException(OverpassRoadNetworkSource.ProviderName, remark);
        }

        var nodes = new List<OsmNode>();
        var ways = new List<OsmWay>();
        var relations = new List<OsmRelation>();
        foreach (var e in response.Elements)
        {
            switch (e.Type)
            {
                case "node" when e.Lat is { } lat && e.Lon is { } lon && lat is >= -90 and <= 90 && lon is >= -180 and <= 180:
                    nodes.Add(new OsmNode(e.Id, new GeoPoint(lat, lon), Tags(e.Tags)));
                    break;
                case "way" when e.Nodes is { Count: >= 2 }:
                    ways.Add(new OsmWay(e.Id, e.Nodes, Tags(e.Tags)));
                    break;
                case "relation" when e.Members is { Count: > 0 }:
                    relations.Add(new OsmRelation(e.Id, Members(e.Members), Tags(e.Tags)));
                    break;
            }
        }

        return new OsmDataSet(nodes, ways, response.Meta?.TimestampOsmBase, relations);
    }

    private static List<OsmMember> Members(IReadOnlyList<OverpassMember> members) =>
        members
            .Select(m => (Type: m.Type switch
            {
                "node" => OsmMemberType.Node,
                "way" => OsmMemberType.Way,
                "relation" => OsmMemberType.Relation,
                _ => (OsmMemberType?)null,
            }, m.Ref, Role: m.Role ?? string.Empty))
            .Where(m => m.Type is not null)
            .Select(m => new OsmMember(m.Type!.Value, m.Ref, m.Role))
            .ToList();

    private static IReadOnlyDictionary<string, string> Tags(IReadOnlyDictionary<string, string>? tags) =>
        tags is null || tags.Count == 0 ? OsmTags.Empty : new Dictionary<string, string>(tags, StringComparer.Ordinal);
}
