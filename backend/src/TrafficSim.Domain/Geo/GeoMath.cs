namespace TrafficSim.Domain.Geo;

/// <summary>Spherical helper functions on WGS84 coordinates.</summary>
public static class GeoMath
{
    /// <summary>Mean Earth radius in metres (IUGG).</summary>
    public const double MeanEarthRadiusMeters = 6_371_008.8;

    /// <summary>Great-circle distance between two points using the haversine formula.</summary>
    public static double HaversineDistanceMeters(GeoPoint a, GeoPoint b)
    {
        var lat1 = DegreesToRadians(a.Latitude);
        var lat2 = DegreesToRadians(b.Latitude);
        var dLat = lat2 - lat1;
        var dLon = DegreesToRadians(b.Longitude - a.Longitude);

        var h = Math.Pow(Math.Sin(dLat / 2), 2) + (Math.Cos(lat1) * Math.Cos(lat2) * Math.Pow(Math.Sin(dLon / 2), 2));
        return 2 * MeanEarthRadiusMeters * Math.Asin(Math.Min(1, Math.Sqrt(h)));
    }

    public static double DegreesToRadians(double degrees) => degrees * Math.PI / 180.0;

    public static double RadiansToDegrees(double radians) => radians * 180.0 / Math.PI;
}
