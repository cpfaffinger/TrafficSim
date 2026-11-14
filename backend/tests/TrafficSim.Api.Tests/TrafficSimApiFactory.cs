using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Api.Tests;

/// <summary>In-memory API host with fake providers and no database.</summary>
public sealed class TrafficSimApiFactory : WebApplicationFactory<Program>
{
    public FakeGeocodingProvider Geocoder { get; } = new();

    public FakeActivitySource Activity { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:TrafficSim", string.Empty);
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<IGeocodingProvider>();
            services.RemoveAll<IReverseGeocodingProvider>();
            services.RemoveAll<IRoadNetworkSource>();
            services.RemoveAll<IActivitySource>();
            services.RemoveAll<IElevationProvider>(); // no real terrain tiles in tests (C-33): imports stay flat
            services.AddSingleton<IActivitySource>(Activity);
            services.AddSingleton<IGeocodingProvider>(Geocoder);
            services.AddSingleton<IReverseGeocodingProvider>(Geocoder);
            services.AddSingleton<IRoadNetworkSource, FakeRoadNetworkSource>();
        });
    }
}

public sealed class FakeGeocodingProvider : IGeocodingProvider, IReverseGeocodingProvider
{
    public Exception? Failure { get; set; }

    public GeocodeQuery? LastQuery { get; private set; }

    public ReverseGeocodeQuery? LastReverseQuery { get; private set; }

    public string Name => "fake";

    public int Priority => 1;

    public string Attribution => "Fake attribution";

    public Task<IReadOnlyList<GeocodeResult>> SearchAsync(GeocodeQuery query, CancellationToken cancellationToken)
    {
        LastQuery = query;
        if (Failure is not null)
        {
            throw Failure;
        }

        IReadOnlyList<GeocodeResult> results =
        [
            new("Karlsplatz, Wien", new GeoPoint(48.2004, 16.3699), "highway:pedestrian", new BoundingBox(48.1989, 16.3672, 48.2017, 16.3726), "way/1"),
            new("Somewhere", new GeoPoint(1, 2), "place:village"),
        ];
        return Task.FromResult(results);
    }

    public Task<GeocodeResult?> ReverseAsync(ReverseGeocodeQuery query, CancellationToken cancellationToken)
    {
        LastReverseQuery = query;
        if (Failure is not null)
        {
            throw Failure;
        }

        return Task.FromResult<GeocodeResult?>(query.Location.Latitude > 80
            ? null
            : new GeocodeResult("Ring, Wien", query.Location, "highway:primary", OsmReference: "way/2"));
    }
}
