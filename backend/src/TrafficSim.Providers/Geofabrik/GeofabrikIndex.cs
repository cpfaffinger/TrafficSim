using System.Text.Json;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Providers.Geofabrik;

/// <summary>A downloadable Geofabrik region with its boundary polygons (outer rings, lon/lat).</summary>
internal sealed record GeofabrikRegion(string Id, string Name, Uri PbfUrl, IReadOnlyList<IReadOnlyList<(double Lon, double Lat)>> Rings)
{
    /// <summary>Approximate size used to prefer the smallest covering region.</summary>
    public double BoundsArea
    {
        get
        {
            var points = Rings.SelectMany(r => r).ToList();
            return points.Count == 0 ? double.MaxValue : (points.Max(p => p.Lon) - points.Min(p => p.Lon)) * (points.Max(p => p.Lat) - points.Min(p => p.Lat));
        }
    }

    public bool Contains(double lat, double lon) => Rings.Any(ring => PointInRing(ring, lon, lat));

    public bool Covers(BoundingBox area) =>
        Contains(area.South, area.West) && Contains(area.South, area.East) &&
        Contains(area.North, area.West) && Contains(area.North, area.East);

    private static bool PointInRing(IReadOnlyList<(double Lon, double Lat)> ring, double x, double y)
    {
        var inside = false;
        for (int i = 0, j = ring.Count - 1; i < ring.Count; j = i++)
        {
            var (xi, yi) = ring[i];
            var (xj, yj) = ring[j];
            if ((yi > y) != (yj > y) && x < ((xj - xi) * (y - yi) / (yj - yi)) + xi)
            {
                inside = !inside;
            }
        }

        return inside;
    }
}

/// <summary>Parses Geofabrik's index-v1.json (GeoJSON) and selects the smallest region covering an area.</summary>
internal static class GeofabrikIndex
{
    public static IReadOnlyList<GeofabrikRegion> Parse(Stream json)
    {
        using var doc = JsonDocument.Parse(json);
        var regions = new List<GeofabrikRegion>();
        if (!doc.RootElement.TryGetProperty("features", out var features) || features.ValueKind != JsonValueKind.Array)
        {
            throw new JsonException("Geofabrik index without features");
        }

        foreach (var feature in features.EnumerateArray())
        {
            if (!feature.TryGetProperty("properties", out var props)
                || !props.TryGetProperty("id", out var id)
                || !props.TryGetProperty("urls", out var urls)
                || !urls.TryGetProperty("pbf", out var pbf)
                || !Uri.TryCreate(pbf.GetString(), UriKind.Absolute, out var pbfUrl)
                || !feature.TryGetProperty("geometry", out var geometry)
                || geometry.ValueKind != JsonValueKind.Object)
            {
                continue;
            }

            var name = props.TryGetProperty("name", out var n) ? n.GetString() ?? id.GetString()! : id.GetString()!;
            regions.Add(new GeofabrikRegion(id.GetString()!, name, pbfUrl, OuterRings(geometry)));
        }

        return regions;
    }

    public static GeofabrikRegion? Select(IEnumerable<GeofabrikRegion> regions, BoundingBox area) =>
        regions.Where(r => r.Covers(area)).OrderBy(r => r.BoundsArea).FirstOrDefault();

    private static List<IReadOnlyList<(double Lon, double Lat)>> OuterRings(JsonElement geometry)
    {
        var type = geometry.GetProperty("type").GetString();
        var coords = geometry.GetProperty("coordinates");
        var polygons = type switch
        {
            "Polygon" => [coords],
            "MultiPolygon" => coords.EnumerateArray().ToList(),
            _ => new List<JsonElement>(),
        };
        return polygons
            .Select(p => (IReadOnlyList<(double, double)>)p.EnumerateArray().First().EnumerateArray()
                .Select(pt => (pt[0].GetDouble(), pt[1].GetDouble())).ToList())
            .ToList();
    }
}
