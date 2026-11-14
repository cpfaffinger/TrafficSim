namespace TrafficSim.Application.Providers;

/// <summary>What a provider can be used for.</summary>
public enum ProviderCapability
{
    Geocoding,
    ReverseGeocoding,
    RoadNetwork,
    Basemap,
    Elevation,
}

/// <summary>Public description of a configured provider (registry entry, ADR-0004).</summary>
/// <param name="Name">Stable provider name.</param>
/// <param name="Capabilities">Ports the provider implements.</param>
/// <param name="Enabled">Whether the provider is active in this deployment.</param>
/// <param name="Priority">Lower = tried first within a capability.</param>
/// <param name="Attribution">Text that must be shown with its data.</param>
/// <param name="Endpoint">Base URL (without credentials).</param>
/// <param name="Commercial">True for paid services (off by default, C-08).</param>
public sealed record ProviderDescriptor(
    string Name,
    IReadOnlyList<ProviderCapability> Capabilities,
    bool Enabled,
    int Priority,
    string Attribution,
    Uri? Endpoint,
    bool Commercial);

/// <summary>The provider registry: every known provider, enabled or not.</summary>
public interface IProviderCatalog
{
    IReadOnlyList<ProviderDescriptor> Providers { get; }
}
