namespace TrafficSim.Application.Providers;

/// <summary>Common shape of every external provider adapter (ADR-0004).</summary>
public interface IProvider
{
    /// <summary>Stable provider name used in configuration and responses.</summary>
    string Name { get; }

    /// <summary>Lower value = tried first.</summary>
    int Priority { get; }

    /// <summary>Attribution text that must be displayed with data from this provider.</summary>
    string Attribution { get; }
}
