using TrafficSim.Application.Demo;

namespace TrafficSim.Api.Endpoints;

/// <summary>The synthetic demo town (#145): a network package without an import.</summary>
internal static class DemoEndpoints
{
    public static RouteGroupBuilder MapDemoEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/demo/package", (HttpContext context, CancellationToken cancellationToken) =>
        {
            context.Response.Headers.CacheControl = "public, max-age=3600";
            return NetworkEndpoints.GzipJsonAsync(context, DemoTown.GzipPackage, cancellationToken);
        })
        .WithName("GetDemoPackage");
        return group;
    }
}
