namespace TrafficSim.Domain.Network.Compilation;

/// <summary>Tunables of the OSM → lane graph compiler (defaults are flagged as assumed where they apply).</summary>
public sealed class CompilerOptions
{
    /// <summary>Signal nodes this close to a junction control that junction (OSM tags signals on approaches).</summary>
    public double SignalCaptureMetres { get; init; } = 35;

    /// <summary>Stop / give-way nodes this close to a junction apply to that approach.</summary>
    public double SignCaptureMetres { get; init; } = 35;

    /// <summary>Solid approach zone before signalised junctions (no lane changes).</summary>
    public double SolidApproachMetres { get; init; } = 30;

    public double SignalCycleSeconds { get; init; } = 90;

    public double AmberSeconds { get; init; } = 3;

    public double AllRedSeconds { get; init; } = 2;
}
