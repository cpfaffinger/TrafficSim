using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Providers.Photon;

/// <summary>Translates Photon DTOs into canonical <see cref="GeocodeResult"/>s (anti-corruption layer).</summary>
internal static class PhotonMapper
{
    public static IReadOnlyList<GeocodeResult> Map(PhotonFeatureCollection? collection)
    {
        if (collection?.Features is null)
        {
            return [];
        }

        var results = new List<GeocodeResult>(collection.Features.Count);
        foreach (var feature in collection.Features)
        {
            var mapped = Map(feature);
            if (mapped is not null)
            {
                results.Add(mapped);
            }
        }

        return results;
    }

    /// <summary>Returns null for features without a valid point geometry (they are skipped).</summary>
    public static GeocodeResult? Map(PhotonFeature feature)
    {
        var coords = feature.Geometry?.Coordinates;
        if (coords is not { Count: >= 2 } || !IsValid(coords[1], coords[0]))
        {
            return null;
        }

        var props = feature.Properties ?? new PhotonProperties();
        return new GeocodeResult(
            Label: BuildLabel(props),
            Location: new GeoPoint(coords[1], coords[0]),
            Category: props.OsmKey is null ? "unknown" : $"{props.OsmKey}:{props.OsmValue ?? "yes"}",
            Extent: MapExtent(props.Extent),
            OsmReference: MapOsmReference(props.OsmType, props.OsmId));
    }

    internal static string BuildLabel(PhotonProperties props)
    {
        var street = props.Street is null
            ? null
            : props.HouseNumber is null ? props.Street : $"{props.Street} {props.HouseNumber}";
        var locality = props.Postcode is null
            ? props.City
            : props.City is null ? props.Postcode : $"{props.Postcode} {props.City}";

        // City states (Wien, Berlin, Hamburg) repeat the city as state; drop the redundant part.
        var state = string.Equals(props.State, props.City, StringComparison.Ordinal) ? null : props.State;
        var parts = new[] { props.Name, street, locality, state, props.Country }
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Distinct(StringComparer.Ordinal);
        var label = string.Join(", ", parts);
        return label.Length == 0 ? "Unnamed place" : label;
    }

    internal static BoundingBox? MapExtent(IReadOnlyList<double>? extent)
    {
        if (extent is not { Count: 4 })
        {
            return null;
        }

        double west = extent[0], north = extent[1], east = extent[2], south = extent[3];
        if (!IsValid(south, west) || !IsValid(north, east) || south >= north || west >= east)
        {
            return null;
        }

        return new BoundingBox(south, west, north, east);
    }

    internal static string? MapOsmReference(string? osmType, long? osmId)
    {
        if (osmId is null)
        {
            return null;
        }

        var type = osmType switch
        {
            "N" => "node",
            "W" => "way",
            "R" => "relation",
            _ => null,
        };
        return type is null ? null : $"{type}/{osmId}";
    }

    private static bool IsValid(double lat, double lon) =>
        !double.IsNaN(lat) && !double.IsNaN(lon) && lat is >= -90 and <= 90 && lon is >= -180 and <= 180;
}
