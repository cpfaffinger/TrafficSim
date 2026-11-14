using TrafficSim.Domain.Network;

namespace TrafficSim.Application.Networks;

/// <summary>
/// Optional package key <c>terrain</c> (#87, ADR-0018): a regular height grid in the local plane, heights
/// relative to the ground at the origin, row-major from the south-west corner (network package v1).
/// </summary>
public sealed record PackageTerrain(
    double West,
    double South,
    double CellSize,
    int Columns,
    int Rows,
    IReadOnlyList<double> Heights,
    double OriginElevation)
{
    public static PackageTerrain? From(TerrainGrid? grid) => grid is null
        ? null
        : new PackageTerrain(
            Math.Round(grid.West, 3),
            Math.Round(grid.South, 3),
            grid.CellSize,
            grid.Columns,
            grid.Rows,
            grid.Heights.Select(h => Math.Round(h, 1)).ToList(),
            Math.Round(grid.OriginElevation, 1));

    /// <summary>The domain grid, or null when the stored grid is inconsistent (treated as flat).</summary>
    public TerrainGrid? ToGrid()
    {
        try
        {
            return new TerrainGrid(West, South, CellSize, Columns, Rows, Heights ?? [], OriginElevation);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }
}
