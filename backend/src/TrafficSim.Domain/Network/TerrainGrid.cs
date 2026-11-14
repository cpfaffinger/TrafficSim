namespace TrafficSim.Domain.Network;

/// <summary>
/// Regular terrain height grid in the local East-North plane (ADR-0018). Heights are metres relative
/// to the ground at the area origin, stored row by row from south to north, west to east within a row.
/// </summary>
public sealed class TerrainGrid
{
    public TerrainGrid(double west, double south, double cellSize, int columns, int rows, IReadOnlyList<double> heights, double originElevation = 0)
    {
        ArgumentNullException.ThrowIfNull(heights);
        if (!double.IsFinite(west) || !double.IsFinite(south))
        {
            throw new ArgumentException("Grid corner must be finite.", nameof(west));
        }

        if (!double.IsFinite(cellSize) || cellSize <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(cellSize), cellSize, "Cell size must be positive.");
        }

        if (columns < 2 || rows < 2)
        {
            throw new ArgumentOutOfRangeException(nameof(columns), "A terrain grid needs at least 2×2 samples.");
        }

        if (heights.Count != columns * rows || heights.Any(h => !double.IsFinite(h)))
        {
            throw new ArgumentException($"Expected {columns * rows} finite heights.", nameof(heights));
        }

        West = west;
        South = south;
        CellSize = cellSize;
        Columns = columns;
        Rows = rows;
        Heights = heights;
        OriginElevation = double.IsFinite(originElevation) ? originElevation : 0;
    }

    /// <summary>East coordinate (m) of the first column.</summary>
    public double West { get; }

    /// <summary>North coordinate (m) of the first row.</summary>
    public double South { get; }

    /// <summary>Spacing of the samples in both directions (m).</summary>
    public double CellSize { get; }

    public int Columns { get; }

    public int Rows { get; }

    /// <summary>Heights relative to the origin's ground (m), row-major from the south-west corner.</summary>
    public IReadOnlyList<double> Heights { get; }

    /// <summary>Ground height of the origin above sea level (m, source datum); informational.</summary>
    public double OriginElevation { get; }

    public double East => West + ((Columns - 1) * CellSize);

    public double North => South + ((Rows - 1) * CellSize);

    /// <summary>Bilinearly interpolated height at a local position; positions outside are clamped to the edge.</summary>
    public double HeightAt(double x, double y)
    {
        var fx = Math.Clamp((x - West) / CellSize, 0, Columns - 1);
        var fy = Math.Clamp((y - South) / CellSize, 0, Rows - 1);
        var c = Math.Min((int)fx, Columns - 2);
        var r = Math.Min((int)fy, Rows - 2);
        var tx = fx - c;
        var ty = fy - r;
        var h00 = Heights[(r * Columns) + c];
        var h10 = Heights[(r * Columns) + c + 1];
        var h01 = Heights[((r + 1) * Columns) + c];
        var h11 = Heights[((r + 1) * Columns) + c + 1];
        return ((h00 * (1 - tx) + (h10 * tx)) * (1 - ty)) + ((h01 * (1 - tx) + (h11 * tx)) * ty);
    }
}
