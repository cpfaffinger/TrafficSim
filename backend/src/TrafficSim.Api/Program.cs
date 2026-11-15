using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.HttpOverrides;
using TrafficSim.Api.Endpoints;
using TrafficSim.Api.Http;
using TrafficSim.Application;
using TrafficSim.Infrastructure;
using TrafficSim.Providers;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddOpenApi();
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

builder.Services
    .AddTrafficSimApplication()
    .AddTrafficSimProviders(builder.Configuration)
    .AddTrafficSimInfrastructure(builder.Configuration);

var app = builder.Build();

app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseMiddleware<SecurityHeadersMiddleware>();

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx => CacheHeaders.Apply(ctx.Context, ctx.File.Name),
});

app.MapOpenApi("/api/openapi/{documentName}.json");
app.MapHealthChecks("/healthz", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/readyz", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains(TrafficSim.Infrastructure.ServiceCollectionExtensions.ReadyTag),
    ResponseWriter = HealthResponseWriter.WriteAsync,
});

var api = app.MapGroup("/api/v1");
api.MapMetaEndpoints();
api.MapGeocodingEndpoints();
api.MapProviderEndpoints();
api.MapNetworkEndpoints();
api.MapScenarioEndpoints();
api.MapExportEndpoints();
api.MapBatchEndpoints();
api.MapDemoEndpoints();

// SPA fallback: unknown non-API routes serve index.html (client-side routing).
app.MapFallbackToFile("{*path:nonfile}", "index.html", new StaticFileOptions
{
    OnPrepareResponse = ctx => CacheHeaders.Apply(ctx.Context, ctx.File.Name),
}).Add(endpoint =>
    ((RouteEndpointBuilder)endpoint).Order = int.MaxValue);
app.MapFallback("/api/{**rest}", () => Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Unknown API route"));

await app.RunAsync().ConfigureAwait(false);

/// <summary>Entry point; public for WebApplicationFactory-based tests.</summary>
public partial class Program;
