namespace TrafficSim.Domain.Geo;

/// <summary>
/// Converts between WGS84 and a local East-North plane in metres around an origin (ADR-0011).
/// Uses the WGS84 meridional and prime-vertical radii of curvature at the origin, which keeps
/// errors in the centimetre range for road-network areas (tens of kilometres).
/// </summary>
public sealed class LocalTangentPlane
{
    private const double SemiMajorAxis = 6_378_137.0;
    private const double Flattening = 1 / 298.257223563;
    private static readonly double EccentricitySquared = Flattening * (2 - Flattening);

    private readonly double _metersPerRadianNorth;
    private readonly double _metersPerRadianEast;

    public LocalTangentPlane(GeoPoint origin)
    {
        Origin = origin;
        var phi = GeoMath.DegreesToRadians(origin.Latitude);
        var sinPhi = Math.Sin(phi);
        var w = Math.Sqrt(1 - (EccentricitySquared * sinPhi * sinPhi));
        var meridionalRadius = SemiMajorAxis * (1 - EccentricitySquared) / (w * w * w);
        var primeVerticalRadius = SemiMajorAxis / w;
        _metersPerRadianNorth = meridionalRadius;
        _metersPerRadianEast = primeVerticalRadius * Math.Cos(phi);
    }

    public GeoPoint Origin { get; }

    public LocalPoint ToLocal(GeoPoint point)
    {
        var east = GeoMath.DegreesToRadians(point.Longitude - Origin.Longitude) * _metersPerRadianEast;
        var north = GeoMath.DegreesToRadians(point.Latitude - Origin.Latitude) * _metersPerRadianNorth;
        return new LocalPoint(east, north);
    }

    public GeoPoint ToGeo(LocalPoint point)
    {
        var lat = Origin.Latitude + GeoMath.RadiansToDegrees(point.North / _metersPerRadianNorth);
        var lon = Origin.Longitude + GeoMath.RadiansToDegrees(point.East / _metersPerRadianEast);
        return new GeoPoint(lat, lon);
    }
}

/// <summary>A position in a local tangent plane, in metres east and north of the origin.</summary>
public readonly record struct LocalPoint(double East, double North);
