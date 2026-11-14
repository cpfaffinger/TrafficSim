using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Domain.Tests.Network;

/// <summary>Builds small OSM data sets in local metres around (48.2, 16.37) for compiler tests.</summary>
internal sealed class OsmBuilder
{
    public static readonly GeoPoint Origin = new(48.2, 16.37);
    private readonly LocalTangentPlane _plane = new(Origin);
    private readonly List<OsmNode> _nodes = [];
    private readonly List<OsmWay> _ways = [];
    private readonly List<OsmRelation> _relations = [];

    /// <summary>Area of ±<paramref name="half"/> metres around the origin.</summary>
    public BoundingBox Area(double half = 300)
    {
        var sw = _plane.ToGeo(new LocalPoint(-half, -half));
        var ne = _plane.ToGeo(new LocalPoint(half, half));
        return new BoundingBox(sw.Latitude, sw.Longitude, ne.Latitude, ne.Longitude);
    }

    public OsmBuilder Node(long id, double x, double y, params (string, string)[] tags)
    {
        _nodes.Add(new OsmNode(id, _plane.ToGeo(new LocalPoint(x, y)), OsmTags.Of(tags)));
        return this;
    }

    public OsmBuilder Way(long id, long[] nodes, params (string, string)[] tags)
    {
        _ways.Add(new OsmWay(id, nodes, OsmTags.Of(tags)));
        return this;
    }

    /// <summary>A relation (#85); members as (type, ref, role).</summary>
    public OsmBuilder Relation(long id, (OsmMemberType Type, long Ref, string Role)[] members, params (string, string)[] tags)
    {
        _relations.Add(new OsmRelation(id, members.Select(m => new OsmMember(m.Type, m.Ref, m.Role)).ToList(), OsmTags.Of(tags)));
        return this;
    }

    public OsmDataSet Build() => new(_nodes, _ways, null, _relations);
}
