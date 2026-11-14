using Microsoft.Extensions.Logging;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Network;

namespace TrafficSim.Application.Networks;

/// <summary>A terrain grid together with the provider that delivered it.</summary>
public sealed record TerrainAnswer(TerrainGrid Grid, string Provider, string Attribution);

/// <summary>
/// Samples the terrain grid of an import area (#87, ADR-0018) from the elevation providers in priority
/// order. Heights are stored relative to the ground at the area origin (the compiler's tangent-plane
/// origin, the bounds centre). Never throws for provider problems: an import without terrain is flat.
/// </summary>
public sealed partial class TerrainService(IEnumerable<IElevationProvider> providers, ILogger<TerrainService> logger)
{
    /// <summary>Smallest grid spacing (m); the free DEMs have about 30 m resolution.</summary>
    public const double MinCellMetres = 30;

    /// <summary>Upper bound of samples per grid side (keeps packages small).</summary>
    public const int MaxSamplesPerSide = 256;

    /// <summary>Total time an import waits for elevation data.</summary>
    public static readonly TimeSpan Budget = TimeSpan.FromSeconds(90);

    private readonly IReadOnlyList<IElevationProvider> _providers = ProviderFallback.Order(providers ?? []);

    /// <summary>Grid layout covering the area's bounds with one cell of margin: (west, south, cell, columns, rows).</summary>
    public static (double West, double South, double Cell, int Columns, int Rows) Layout(BoundingBox bounds)
    {
        ArgumentNullException.ThrowIfNull(bounds);
        var plane = new LocalTangentPlane(bounds.Center);
        var sw = plane.ToLocal(bounds.SouthWest);
        var ne = plane.ToLocal(bounds.NorthEast);
        var width = ne.East - sw.East;
        var height = ne.North - sw.North;
        var cell = Math.Max(MinCellMetres, Math.Ceiling(Math.Max(width, height) / (MaxSamplesPerSide - 3)));
        var columns = (int)Math.Ceiling(width / cell) + 3;
        var rows = (int)Math.Ceiling(height / cell) + 3;
        return (sw.East - cell, sw.North - cell, cell, columns, rows);
    }

    /// <summary>The terrain under <paramref name="area"/>, or null (flat) when no provider delivers data.</summary>
    public async Task<TerrainAnswer?> SampleAsync(GeoPolygon area, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(area);
        if (_providers.Count == 0)
        {
            return null;
        }

        var (west, south, cell, columns, rows) = Layout(area.Bounds);
        var plane = new LocalTangentPlane(area.Bounds.Center);
        var points = new List<GeoPoint>((columns * rows) + 1);
        for (var r = 0; r < rows; r++)
        {
            for (var c = 0; c < columns; c++)
            {
                points.Add(plane.ToGeo(new LocalPoint(west + (c * cell), south + (r * cell))));
            }
        }

        points.Add(plane.Origin);
        foreach (var provider in _providers)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Budget);
            try
            {
                var heights = await provider.SampleAsync(points, timeout.Token).ConfigureAwait(false);
                if (Build(west, south, cell, columns, rows, heights) is { } grid)
                {
                    LogSampled(provider.Name, columns, rows, cell);
                    return new TerrainAnswer(grid, provider.Name, provider.Attribution);
                }

                LogFailed(provider.Name, "no elevation data for the area");
            }
            catch (ProviderUnavailableException ex)
            {
                LogFailed(provider.Name, ex.Message);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                LogFailed(provider.Name, $"no answer within {Budget.TotalSeconds:F0} s");
            }
        }

        return null;
    }

    /// <summary>
    /// Builds the relative grid from absolute heights (grid samples row-major, then the origin). Missing
    /// samples get the mean of the others; heights are rounded to 0.1 m as stored in the package.
    /// </summary>
    internal static TerrainGrid? Build(double west, double south, double cell, int columns, int rows, IReadOnlyList<double?> heights)
    {
        var count = columns * rows;
        if (heights is null || heights.Count != count + 1)
        {
            return null;
        }

        var known = heights.Take(count).Where(h => h is { } v && double.IsFinite(v)).Select(h => h!.Value).ToList();
        if (known.Count == 0)
        {
            return null;
        }

        var fill = known.Average();
        var origin = heights[count] is { } o && double.IsFinite(o) ? o : fill;
        var relative = heights.Take(count)
            .Select(h => Math.Round((h is { } v && double.IsFinite(v) ? v : fill) - origin, 1))
            .ToList();
        return new TerrainGrid(west, south, cell, columns, rows, relative, Math.Round(origin, 1));
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Terrain from {Provider}: {Columns}×{Rows} samples, {Cell} m cells")]
    private partial void LogSampled(string provider, int columns, int rows, double cell);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Elevation provider {Provider} failed, the network stays flat: {Reason}")]
    private partial void LogFailed(string provider, string reason);
}
