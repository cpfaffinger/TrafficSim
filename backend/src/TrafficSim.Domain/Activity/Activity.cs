using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Network.Compilation;

namespace TrafficSim.Domain.Activity;

/// <summary>What a place generates or attracts trips for (#115).</summary>
public enum ActivityKind
{
    /// <summary>Weight = dwelling units.</summary>
    Housing,

    /// <summary>Weight = jobs.</summary>
    Work,

    /// <summary>Weight = retail attraction units (≈ visits per hour at peak / 10).</summary>
    Retail,

    /// <summary>Weight = pupils / students.</summary>
    Education,

    /// <summary>Weight = visitor capacity (events, sports, culture).</summary>
    Leisure,

    /// <summary>Weight = freight generation units (industrial / logistics).</summary>
    Freight,

    /// <summary>Weight = parking spaces.</summary>
    Parking,
}

/// <summary>A point of trip generation or attraction derived from OSM buildings, land use and POIs.</summary>
public sealed record ActivityFeature(ActivityKind Kind, GeoPoint Location, double Weight, string Tag);

/// <summary>A raw OSM element (node, or way/relation centre) with tags, as delivered by an activity source.</summary>
public sealed record OsmPoi(GeoPoint Location, IReadOnlyDictionary<string, string> Tags);

/// <summary>
/// Classifies OSM elements into trip generators (#115). The unit weights are documented assumptions
/// (dwelling units per apartment level, jobs per office level, …) and are refined by <c>building:levels</c>.
/// </summary>
public static class ActivityClassifier
{
    public static IEnumerable<ActivityFeature> Classify(OsmPoi poi)
    {
        ArgumentNullException.ThrowIfNull(poi);
        var t = poi.Tags;
        var building = Tags.Get(t, "building");
        var levels = Levels(t);
        var p = poi.Location;

        switch (building)
        {
            case "apartments":
                yield return new(ActivityKind.Housing, p, (levels ?? 4) * 4, "building=apartments");
                break;
            case "residential" or "dormitory":
                yield return new(ActivityKind.Housing, p, (levels ?? 3) * 3, $"building={building}");
                break;
            case "house" or "detached" or "semidetached_house" or "bungalow":
                yield return new(ActivityKind.Housing, p, 1, $"building={building}");
                break;
            case "terrace":
                yield return new(ActivityKind.Housing, p, 4, "building=terrace");
                break;
            case "office":
                yield return new(ActivityKind.Work, p, (levels ?? 4) * 25, "building=office");
                break;
            case "commercial":
                yield return new(ActivityKind.Work, p, (levels ?? 3) * 15, "building=commercial");
                break;
            case "retail":
                yield return new(ActivityKind.Retail, p, 15, "building=retail");
                yield return new(ActivityKind.Work, p, 10, "building=retail");
                break;
            case "industrial":
                yield return new(ActivityKind.Work, p, 40, "building=industrial");
                yield return new(ActivityKind.Freight, p, 10, "building=industrial");
                break;
            case "warehouse":
                yield return new(ActivityKind.Work, p, 10, "building=warehouse");
                yield return new(ActivityKind.Freight, p, 20, "building=warehouse");
                break;
        }

        switch (Tags.Get(t, "landuse"))
        {
            case "residential" when building is null:
                yield return new(ActivityKind.Housing, p, 30, "landuse=residential");
                break;
            case "commercial" when building is null:
                yield return new(ActivityKind.Work, p, 50, "landuse=commercial");
                break;
            case "retail" when building is null:
                yield return new(ActivityKind.Retail, p, 30, "landuse=retail");
                break;
            case "industrial" when building is null:
                yield return new(ActivityKind.Work, p, 150, "landuse=industrial");
                yield return new(ActivityKind.Freight, p, 50, "landuse=industrial");
                break;
        }

        if (Tags.Get(t, "shop") is { } shop)
        {
            var weight = shop switch
            {
                "mall" => 200,
                "department_store" => 100,
                "supermarket" => 20,
                "doityourself" or "hardware" or "furniture" or "car" => 15,
                _ => 3,
            };
            yield return new(ActivityKind.Retail, p, weight, $"shop={shop}");
            yield return new(ActivityKind.Work, p, Math.Max(2, weight / 3.0), $"shop={shop}");
        }

        if (Tags.Get(t, "office") is { } office && building != "office")
        {
            yield return new(ActivityKind.Work, p, 15, $"office={office}");
        }

        switch (Tags.Get(t, "amenity"))
        {
            case "school":
                yield return new(ActivityKind.Education, p, 400, "amenity=school");
                yield return new(ActivityKind.Work, p, 40, "amenity=school");
                break;
            case "kindergarten":
                yield return new(ActivityKind.Education, p, 60, "amenity=kindergarten");
                break;
            case "university" or "college":
                yield return new(ActivityKind.Education, p, 1500, "amenity=university");
                yield return new(ActivityKind.Work, p, 200, "amenity=university");
                break;
            case "hospital":
                yield return new(ActivityKind.Work, p, 400, "amenity=hospital");
                yield return new(ActivityKind.Leisure, p, 100, "amenity=hospital");
                break;
            case "townhall":
                yield return new(ActivityKind.Work, p, 100, "amenity=townhall");
                break;
            case "marketplace":
                yield return new(ActivityKind.Retail, p, 20, "amenity=marketplace");
                break;
            case "theatre" or "cinema" or "arts_centre" or "events_venue":
                yield return new(ActivityKind.Leisure, p, 300, $"amenity={Tags.Get(t, "amenity")}");
                break;
            case "parking":
                yield return new(ActivityKind.Parking, p, Tags.GetInt(t, "capacity") is { } cap and > 0 ? cap : 50, "amenity=parking");
                break;
        }

        switch (Tags.Get(t, "leisure"))
        {
            case "stadium":
                yield return new(ActivityKind.Leisure, p, 5000, "leisure=stadium");
                break;
            case "sports_centre":
                yield return new(ActivityKind.Leisure, p, 150, "leisure=sports_centre");
                break;
        }
    }

    private static double? Levels(IReadOnlyDictionary<string, string> tags) =>
        double.TryParse(Tags.Get(tags, "building:levels"), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var l) && l is >= 1 and <= 60
            ? Math.Round(l)
            : null;
}
