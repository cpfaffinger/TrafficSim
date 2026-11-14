using System.Globalization;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Providers.Nominatim;

/// <summary>Translates Nominatim places into canonical results (anti-corruption layer).</summary>
internal static class NominatimMapper
{
    public static GeocodeResult? Map(NominatimPlace? place)
    {
        if (place is null || place.Error is not null || !TryParse(place.Lat, out var lat) || !TryParse(place.Lon, out var lon)
            || lat is < -90 or > 90 || lon is < -180 or > 180)
        {
            return null;
        }

        return new GeocodeResult(
            Label: string.IsNullOrWhiteSpace(place.DisplayName) ? "Unnamed place" : place.DisplayName.Trim(),
            Location: new GeoPoint(lat, lon),
            Category: place.Category is null ? "unknown" : $"{place.Category}:{place.Type ?? "yes"}",
            Extent: MapExtent(place.BoundingBox),
            OsmReference: place.OsmId is { } id && place.OsmType is "node" or "way" or "relation" ? $"{place.OsmType}/{id}" : null);
    }

    internal static BoundingBox? MapExtent(IReadOnlyList<string>? box)
    {
        if (box is not { Count: 4 } || !TryParse(box[0], out var south) || !TryParse(box[1], out var north)
            || !TryParse(box[2], out var west) || !TryParse(box[3], out var east)
            || south >= north || west >= east || south < -90 || north > 90 || west < -180 || east > 180)
        {
            return null;
        }

        return new BoundingBox(south, west, north, east);
    }

    private static bool TryParse(string? value, out double result) =>
        double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out result) && !double.IsNaN(result);
}
