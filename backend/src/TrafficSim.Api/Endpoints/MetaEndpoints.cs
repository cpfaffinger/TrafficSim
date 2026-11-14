using System.Reflection;
using TrafficSim.Application.Providers;

namespace TrafficSim.Api.Endpoints;

/// <summary>Application metadata: version and attributions of active providers (C-17).</summary>
public sealed record MetaResponse(string Name, string Version, IReadOnlyList<string> Attributions);

internal static class MetaEndpoints
{
    public const string OsmAttribution = "Map data © OpenStreetMap contributors (ODbL)";

    public static RouteGroupBuilder MapMetaEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/meta", (IProviderCatalog catalog) =>
        {
            var version = typeof(MetaEndpoints).Assembly
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
            var attributions = catalog.Providers.Where(p => p.Enabled).Select(p => p.Attribution)
                .Prepend(OsmAttribution)
                .Distinct(StringComparer.Ordinal)
                .ToList();
            return TypedResults.Ok(new MetaResponse("TrafficSim", version, attributions));
        })
        .WithName("GetMeta");

        return group;
    }
}
