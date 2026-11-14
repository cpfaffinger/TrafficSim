using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using Microsoft.Extensions.Options;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.Http;

namespace TrafficSim.Providers.TerrainTiles;

/// <summary>
/// Elevation from the AWS Open Data "Terrain Tiles" in Terrarium encoding (ADR-0018): Web-Mercator PNG
/// tiles at <c>terrarium/{z}/{x}/{y}.png</c>, sampled bilinearly between pixel centres. The zoom adapts so a
/// request needs at most <see cref="TerrainTilesOptions.MaxTiles"/> tiles. Missing tiles (404) give null heights.
/// </summary>
public sealed class TerrainTilesElevationProvider : IElevationProvider
{
    public const string ProviderName = "terrain-tiles";
    public const string AttributionText =
        "Elevation: Terrain Tiles (Mapzen/Tilezen, AWS Open Data) from SRTM, GMTED2010, ETOPO1, USGS 3DEP, EU-DEM © Copernicus and others";

    private const int TileSize = 256;
    private readonly HttpClient _httpClient;
    private readonly TerrainTilesOptions _options;

    public TerrainTilesElevationProvider(HttpClient httpClient, IOptions<ProvidersOptions> options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _httpClient = httpClient;
        _options = options.Value.TerrainTiles;
    }

    public string Name => ProviderName;

    public int Priority => _options.Priority;

    public string Attribution => AttributionText;

    public Task<IReadOnlyList<double?>> SampleAsync(IReadOnlyList<GeoPoint> points, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(points);
        if (points.Count == 0)
        {
            return Task.FromResult<IReadOnlyList<double?>>([]);
        }

        return ProviderErrors.GuardAsync(ProviderName, async () =>
        {
            var zoom = ZoomFor(points, _options.Zoom, _options.MaxTiles);
            var pixels = points.Select(p => PixelOf(p, zoom)).ToList();
            var tiles = await FetchAsync(Tiles(pixels, zoom), zoom, cancellationToken).ConfigureAwait(false);
            return (IReadOnlyList<double?>)pixels.Select(p => Bilinear(tiles, p.X, p.Y, zoom)).ToList();
        }, cancellationToken);
    }

    /// <summary>Global pixel coordinates (pixel centres at .5) of a WGS84 point at a zoom level.</summary>
    internal static (double X, double Y) PixelOf(GeoPoint p, int zoom)
    {
        var size = TileSize * Math.Pow(2, zoom);
        var lat = Math.Clamp(p.Latitude, -85.05112878, 85.05112878) * Math.PI / 180;
        var x = (p.Longitude + 180) / 360 * size;
        var y = (1 - (Math.Log(Math.Tan(lat) + (1 / Math.Cos(lat))) / Math.PI)) / 2 * size;
        return (x, y);
    }

    /// <summary>The highest zoom ≤ <paramref name="maxZoom"/> whose tile cover of the points has at most <paramref name="maxTiles"/> tiles.</summary>
    internal static int ZoomFor(IReadOnlyList<GeoPoint> points, int maxZoom, int maxTiles)
    {
        var zoom = Math.Clamp(maxZoom, 0, 15);
        while (zoom > 0 && Tiles(points.Select(p => PixelOf(p, zoom)).ToList(), zoom).Count > Math.Max(1, maxTiles))
        {
            zoom--;
        }

        return zoom;
    }

    /// <summary>Tiles holding the four neighbouring pixel centres of every point.</summary>
    private static HashSet<(int X, int Y)> Tiles(IReadOnlyList<(double X, double Y)> pixels, int zoom)
    {
        var n = 1 << zoom;
        var minX = (int)Math.Floor((pixels.Min(p => p.X) - 0.5) / TileSize);
        var maxX = (int)Math.Floor((pixels.Max(p => p.X) + 0.5) / TileSize);
        var minY = Math.Max(0, (int)Math.Floor((pixels.Min(p => p.Y) - 0.5) / TileSize));
        var maxY = Math.Min(n - 1, (int)Math.Floor((pixels.Max(p => p.Y) + 0.5) / TileSize));
        var tiles = new HashSet<(int, int)>();
        for (var x = minX; x <= maxX; x++)
        {
            for (var y = minY; y <= maxY; y++)
            {
                tiles.Add((((x % n) + n) % n, y));
            }
        }

        return tiles;
    }

    private async Task<Dictionary<(int X, int Y), TerrariumTile?>> FetchAsync(HashSet<(int X, int Y)> tiles, int zoom, CancellationToken cancellationToken)
    {
        var result = new ConcurrentDictionary<(int X, int Y), TerrariumTile?>();
        await Parallel.ForEachAsync(
            tiles.OrderBy(t => t.Y).ThenBy(t => t.X),
            new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = cancellationToken },
            async (tile, ct) => result[tile] = await FetchTileAsync(zoom, tile.X, tile.Y, ct).ConfigureAwait(false)).ConfigureAwait(false);
        return new Dictionary<(int X, int Y), TerrariumTile?>(result);
    }

    private async Task<TerrariumTile?> FetchTileAsync(int zoom, int x, int y, CancellationToken cancellationToken)
    {
        var path = string.Create(CultureInfo.InvariantCulture, $"terrarium/{zoom}/{x}/{y}.png");
        using var response = await _httpClient.GetAsync(new Uri(path, UriKind.Relative), cancellationToken).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        ProviderErrors.EnsureSuccess(ProviderName, response);
        var body = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return TerrariumPng.Decode(body);
        }
        catch (InvalidDataException ex)
        {
            throw new ProviderUnavailableException(ProviderName, $"invalid tile {path}: {ex.Message}", ex);
        }
    }

    /// <summary>Bilinear interpolation between pixel centres; missing neighbours are skipped (null if none).</summary>
    private static double? Bilinear(Dictionary<(int X, int Y), TerrariumTile?> tiles, double px, double py, int zoom)
    {
        var n = 1 << zoom;
        var fx = px - 0.5;
        var fy = py - 0.5;
        var x0 = (int)Math.Floor(fx);
        var y0 = (int)Math.Floor(fy);
        var tx = fx - x0;
        var ty = fy - y0;
        double sum = 0, weights = 0;
        for (var dy = 0; dy <= 1; dy++)
        {
            for (var dx = 0; dx <= 1; dx++)
            {
                var w = (dx == 0 ? 1 - tx : tx) * (dy == 0 ? 1 - ty : ty);
                var gx = x0 + dx;
                var gy = Math.Clamp(y0 + dy, 0, (n * TileSize) - 1);
                var tileX = (int)Math.Floor((double)gx / TileSize);
                var tile = tiles.GetValueOrDefault((((tileX % n) + n) % n, gy / TileSize));
                if (tile is null || w <= 0)
                {
                    continue;
                }

                var lx = gx - (tileX * TileSize);
                var ly = gy % TileSize;
                if (lx >= tile.Width || ly >= tile.Height)
                {
                    continue;
                }

                sum += w * tile.At(lx, ly);
                weights += w;
            }
        }

        return weights > 1e-9 ? sum / weights : null;
    }
}
