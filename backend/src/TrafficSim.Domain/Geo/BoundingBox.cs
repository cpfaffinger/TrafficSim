namespace TrafficSim.Domain.Geo;

/// <summary>
/// An axis-aligned WGS84 bounding box. Boxes crossing the antimeridian are not supported
/// (not needed for road-network areas).
/// </summary>
public sealed record BoundingBox
{
    public BoundingBox(double south, double west, double north, double east)
    {
        var southWest = new GeoPoint(south, west);
        var northEast = new GeoPoint(north, east);

        if (south >= north)
        {
            throw new ArgumentException("South must be less than north.", nameof(south));
        }

        if (west >= east)
        {
            throw new ArgumentException("West must be less than east (antimeridian crossing is not supported).", nameof(west));
        }

        SouthWest = southWest;
        NorthEast = northEast;
    }

    public GeoPoint SouthWest { get; }

    public GeoPoint NorthEast { get; }

    public double South => SouthWest.Latitude;

    public double West => SouthWest.Longitude;

    public double North => NorthEast.Latitude;

    public double East => NorthEast.Longitude;

    public GeoPoint Center => new((South + North) / 2, (West + East) / 2);

    /// <summary>Approximate area in km² (spherical, exact for a lat/lon rectangle on a sphere).</summary>
    public double AreaSquareKilometers
    {
        get
        {
            var r = GeoMath.MeanEarthRadiusMeters / 1000.0;
            var dLon = GeoMath.DegreesToRadians(East - West);
            var band = Math.Sin(GeoMath.DegreesToRadians(North)) - Math.Sin(GeoMath.DegreesToRadians(South));
            return r * r * dLon * band;
        }
    }

    public bool Contains(GeoPoint point) =>
        point.Latitude >= South && point.Latitude <= North &&
        point.Longitude >= West && point.Longitude <= East;
}
