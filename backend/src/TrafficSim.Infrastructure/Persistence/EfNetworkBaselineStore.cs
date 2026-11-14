using Microsoft.EntityFrameworkCore;
using NetTopologySuite.Geometries;
using TrafficSim.Application.Networks;
using TrafficSim.Domain.Geo;

namespace TrafficSim.Infrastructure.Persistence;

/// <summary>PostGIS-backed baseline store (ADR-0003, ADR-0010).</summary>
public sealed class EfNetworkBaselineStore(TrafficSimDbContext db) : INetworkBaselineStore
{
    private static readonly GeometryFactory Factory = new(new PrecisionModel(), 4326);

    public async Task SaveAsync(NetworkBaselineInfo info, byte[] gzipPackage, byte[]? gzipOsmData, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(info);
        var a = info.Area;
        db.Set<NetworkBaselineEntity>().Add(new NetworkBaselineEntity
        {
            Id = info.Id,
            Area = info.Polygon is { } poly ? ToPolygon(poly) : ToPolygon(a),
            PolygonRing = info.Polygon?.ToString(),
            South = a.South,
            West = a.West,
            North = a.North,
            East = a.East,
            CreatedAt = info.CreatedAt,
            Source = info.Source,
            OsmTimestamp = info.OsmTimestamp,
            Nodes = info.Stats.Nodes,
            Links = info.Stats.Links,
            Lanes = info.Stats.Lanes,
            Connectors = info.Stats.Connectors,
            Signals = info.Stats.Signals,
            Attribution = info.Attribution.ToList(),
            Package = gzipPackage,
            OsmData = gzipOsmData,
        });
        await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<NetworkBaselineInfo?> GetAsync(Guid id, CancellationToken cancellationToken)
    {
        var entity = await Infos().FirstOrDefaultAsync(b => b.Id == id, cancellationToken).ConfigureAwait(false);
        return entity is null ? null : ToInfo(entity);
    }

    public Task<byte[]?> GetPackageAsync(Guid id, CancellationToken cancellationToken) =>
        db.Set<NetworkBaselineEntity>().AsNoTracking().Where(b => b.Id == id).Select(b => (byte[]?)b.Package).FirstOrDefaultAsync(cancellationToken);

    public Task<byte[]?> GetOsmDataAsync(Guid id, CancellationToken cancellationToken) =>
        db.Set<NetworkBaselineEntity>().AsNoTracking().Where(b => b.Id == id).Select(b => b.OsmData).FirstOrDefaultAsync(cancellationToken);

    public async Task<IReadOnlyList<NetworkBaselineInfo>> ListAsync(int limit, CancellationToken cancellationToken)
    {
        var rows = await Infos().OrderByDescending(b => b.CreatedAt).Take(limit).ToListAsync(cancellationToken).ConfigureAwait(false);
        return rows.Select(ToInfo).ToList();
    }

    public async Task<NetworkBaselineInfo?> FindRecentAsync(BoundingBox area, GeoPolygon? polygon, DateTimeOffset since, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(area);
        var ring = polygon?.ToString();
        var entity = await Infos()
            .Where(b => b.South == area.South && b.West == area.West && b.North == area.North && b.East == area.East
                        && b.PolygonRing == ring && b.CreatedAt >= since)
            .OrderByDescending(b => b.CreatedAt)
            .FirstOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);
        return entity is null ? null : ToInfo(entity);
    }

    internal static Polygon ToPolygon(GeoPolygon p)
    {
        ArgumentNullException.ThrowIfNull(p);
        var coords = p.Ring.Select(v => new Coordinate(v.Longitude, v.Latitude)).Append(new Coordinate(p.Ring[0].Longitude, p.Ring[0].Latitude)).ToArray();
        return Factory.CreatePolygon(coords);
    }

    internal static Polygon ToPolygon(BoundingBox a) => Factory.CreatePolygon(
    [
        new Coordinate(a.West, a.South), new Coordinate(a.East, a.South), new Coordinate(a.East, a.North),
        new Coordinate(a.West, a.North), new Coordinate(a.West, a.South),
    ]);

    // Projection without the package blob.
    private IQueryable<NetworkBaselineEntity> Infos() => db.Set<NetworkBaselineEntity>().AsNoTracking().Select(b => new NetworkBaselineEntity
    {
        Id = b.Id,
        Area = b.Area,
        PolygonRing = b.PolygonRing,
        South = b.South,
        West = b.West,
        North = b.North,
        East = b.East,
        CreatedAt = b.CreatedAt,
        Source = b.Source,
        OsmTimestamp = b.OsmTimestamp,
        Nodes = b.Nodes,
        Links = b.Links,
        Lanes = b.Lanes,
        Connectors = b.Connectors,
        Signals = b.Signals,
        Attribution = b.Attribution,
        Package = Array.Empty<byte>(),
    });

    private static NetworkBaselineInfo ToInfo(NetworkBaselineEntity e) => new(
        e.Id,
        new BoundingBox(e.South, e.West, e.North, e.East),
        e.CreatedAt,
        e.Source,
        e.OsmTimestamp,
        new PackageStats(e.Nodes, e.Links, e.Lanes, e.Connectors, e.Signals),
        e.Attribution,
        e.PolygonRing is null ? null : GeoPolygon.Parse(e.PolygonRing));
}
