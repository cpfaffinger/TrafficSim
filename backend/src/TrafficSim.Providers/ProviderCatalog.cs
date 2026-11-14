using Microsoft.Extensions.Options;
using TrafficSim.Application.Providers;
using TrafficSim.Providers.Geofabrik;
using TrafficSim.Providers.Google;
using TrafficSim.Providers.Nominatim;
using TrafficSim.Providers.Overpass;
using TrafficSim.Providers.Photon;

namespace TrafficSim.Providers;

/// <summary>Provider registry built from configuration: every known provider, enabled or not (ADR-0004).</summary>
public sealed class ProviderCatalog(IOptions<ProvidersOptions> options) : IProviderCatalog
{
    public IReadOnlyList<ProviderDescriptor> Providers { get; } = Build(options.Value);

    internal static IReadOnlyList<ProviderDescriptor> Build(ProvidersOptions o)
    {
        ArgumentNullException.ThrowIfNull(o);
        var photonCaps = o.Photon.Reverse
            ? new[] { ProviderCapability.Geocoding, ProviderCapability.ReverseGeocoding }
            : [ProviderCapability.Geocoding];
        return
        [
            new(PhotonGeocodingProvider.ProviderName, photonCaps, o.Photon.Enabled, o.Photon.Priority,
                PhotonGeocodingProvider.AttributionText, o.Photon.BaseUrl, Commercial: false),
            new(NominatimProvider.ProviderName, [ProviderCapability.Geocoding, ProviderCapability.ReverseGeocoding],
                o.Nominatim.Enabled, o.Nominatim.Priority, NominatimProvider.AttributionText, o.Nominatim.BaseUrl, Commercial: false),
            new(OverpassRoadNetworkSource.ProviderName, [ProviderCapability.RoadNetwork], o.Overpass.Enabled,
                o.Overpass.Priority, OverpassRoadNetworkSource.AttributionText, o.Overpass.BaseUrl, Commercial: false),
            new(GeofabrikRoadNetworkSource.ProviderName, [ProviderCapability.RoadNetwork],
                o.Geofabrik.Enabled && !string.IsNullOrWhiteSpace(o.Geofabrik.Directory), o.Geofabrik.Priority,
                GeofabrikRoadNetworkSource.AttributionText, o.Geofabrik.BaseUrl, Commercial: false),
            new(GoogleGeocodingProvider.ProviderName, [ProviderCapability.Geocoding], GoogleGeocodingProvider.IsUsable(o.Google),
                o.Google.Priority, GoogleGeocodingProvider.AttributionText, o.Google.BaseUrl, Commercial: true),
            new("openfreemap", [ProviderCapability.Basemap], o.Basemap.Enabled, 10,
                "OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors (ODbL)", o.Basemap.StyleUrl, Commercial: false),
        ];
    }
}
