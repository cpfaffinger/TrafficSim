namespace TrafficSim.Domain.Osm;

/// <summary>Helpers for public transport route relations (#85, ADR-0019).</summary>
public static class TransitRelations
{
    /// <summary>Route types simulated as buses.</summary>
    public static bool IsBusRoute(OsmRelation relation)
    {
        ArgumentNullException.ThrowIfNull(relation);
        return Get(relation, "type") == "route" && Get(relation, "route") is "bus" or "trolleybus";
    }

    /// <summary>
    /// Rewrites way members after edits split ways (#64): a member referencing a split way is replaced
    /// by its pieces in their order along the original way. Members of deleted ways stay (they no longer
    /// resolve and become gaps).
    /// </summary>
    /// <param name="ways">Current ways as (id, original id, node ids).</param>
    public static IReadOnlyList<OsmRelation> FollowSplits(IReadOnlyList<OsmRelation> relations, IReadOnlyList<(long Id, long OriginalId, IReadOnlyList<long> NodeIds)> ways)
    {
        ArgumentNullException.ThrowIfNull(relations);
        ArgumentNullException.ThrowIfNull(ways);
        if (relations.Count == 0)
        {
            return relations;
        }

        var pieces = ways.Where(w => w.Id != w.OriginalId).ToLookup(w => w.OriginalId);
        if (pieces.Count == 0)
        {
            return relations;
        }

        var byOriginal = ways.ToLookup(w => w.OriginalId);
        return relations.Select(r => r with
        {
            Members = r.Members.SelectMany(m => m.Type == OsmMemberType.Way && pieces.Contains(m.Ref)
                ? Chain(byOriginal[m.Ref].ToList()).Select(id => m with { Ref = id })
                : [m]).ToList(),
        }).ToList();
    }

    /// <summary>Way pieces ordered by following shared end nodes (unchained pieces keep their order).</summary>
    private static List<long> Chain(List<(long Id, long OriginalId, IReadOnlyList<long> NodeIds)> pieces)
    {
        var result = new List<long>();
        var left = pieces.ToList();
        while (left.Count > 0)
        {
            var start = left.FirstOrDefault(p => !left.Any(q => q.Id != p.Id && q.NodeIds[^1] == p.NodeIds[0]));
            var current = start.NodeIds is null ? left[0] : start;
            while (true)
            {
                result.Add(current.Id);
                left.Remove(current);
                var next = left.FirstOrDefault(q => q.NodeIds[0] == current.NodeIds[^1]);
                if (next.NodeIds is null)
                {
                    break;
                }

                current = next;
            }
        }

        return result;
    }

    private static string? Get(OsmRelation r, string key) => r.Tags.TryGetValue(key, out var v) ? v : null;
}
