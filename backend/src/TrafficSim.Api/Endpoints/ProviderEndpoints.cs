using TrafficSim.Application.Providers;

namespace TrafficSim.Api.Endpoints;

public sealed record ProviderDto(
    string Name,
    IReadOnlyList<string> Capabilities,
    bool Enabled,
    int Priority,
    string Attribution,
    string? Endpoint,
    bool Commercial);

internal static class ProviderEndpoints
{
    public static RouteGroupBuilder MapProviderEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/providers", (IProviderCatalog catalog) => TypedResults.Ok(catalog.Providers
                .Select(p => new ProviderDto(
                    p.Name,
                    p.Capabilities.Select(c => System.Text.Json.JsonNamingPolicy.CamelCase.ConvertName(c.ToString())).ToList(),
                    p.Enabled,
                    p.Priority,
                    p.Attribution,
                    p.Endpoint?.GetLeftPart(UriPartial.Path),
                    p.Commercial))
                .ToList()))
            .WithName("GetProviders");
        return group;
    }
}
