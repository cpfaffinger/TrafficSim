namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Tunables of the OSM → lane graph compiler (defaults are flagged as assumed where they apply).</summary>
public sealed class CompilerOptions
{
    /// <summary>Signal nodes this close to a junction control that junction (OSM tags signals on approaches).</summary>
    public double SignalCaptureMetres { get; init; } = 35;

    /// <summary>Stop / give-way signs apply to the next junction in their direction up to this road distance (#102).</summary>
    public double SignCaptureMetres { get; init; } = 60;

    /// <summary>Solid approach zone before signalised junctions (no lane changes).</summary>
    public double SolidApproachMetres { get; init; } = 30;

    public double SignalCycleSeconds { get; init; } = 90;

    public double AmberSeconds { get; init; } = 3;

    public double AllRedSeconds { get; init; } = 2;

    /// <summary>Terrain under the network (ADR-0018); null keeps the network flat apart from grade separation.</summary>
    public TerrainGrid? Terrain { get; init; }
}
