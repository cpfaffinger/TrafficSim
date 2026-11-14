using Microsoft.Extensions.Logging.Abstractions;
using TrafficSim.Application.Providers;
using TrafficSim.Application.RoadSources;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Tests.RoadSources;

public class RoadNetworkServiceTests
{
    private sealed class Source(string name, int priority, double maxArea, bool fail = false) : IRoadNetworkSource
    {
        public int Calls { get; private set; }

        public string Name => name;

        public int Priority => priority;

        public string Attribution => name;

        public double MaxAreaSquareKilometers => maxArea;

        public Task<OsmDataSet> FetchAsync(BoundingBox area, CancellationToken cancellationToken)
        {
            Calls++;
            return fail ? throw new ProviderUnavailableException(name, "down") : Task.FromResult(new OsmDataSet([], []));
        }
    }

    // ~1.1 km x 0.75 km ≈ 0.8 km²
    private static readonly BoundingBox Small = new(48.20, 16.36, 48.21, 16.37);

    // ~11 km x 7.4 km ≈ 82 km²
    private static readonly BoundingBox Large = new(48.1, 16.3, 48.2, 16.4);

    [Fact]
    public async Task Small_area_uses_highest_priority_source()
    {
        var overpass = new Source("overpass", 10, 50);
        var geofabrik = new Source("geofabrik", 50, 2500);
        var service = new RoadNetworkService([geofabrik, overpass], NullLogger<RoadNetworkService>.Instance);

        var answer = await service.FetchAsync(Small, TestContext.Current.CancellationToken);

        Assert.Equal("overpass", answer.Provider);
        Assert.Equal(0, geofabrik.Calls);
        Assert.Equal(2500, service.MaxAreaSquareKilometers);
    }

    [Fact]
    public async Task Large_area_skips_sources_with_smaller_limits()
    {
        var overpass = new Source("overpass", 10, 50);
        var geofabrik = new Source("geofabrik", 50, 2500);
        var service = new RoadNetworkService([overpass, geofabrik], NullLogger<RoadNetworkService>.Instance);

        var answer = await service.FetchAsync(Large, TestContext.Current.CancellationToken);

        Assert.Equal("geofabrik", answer.Provider);
        Assert.Equal(0, overpass.Calls);
    }

    [Fact]
    public async Task Falls_back_when_source_fails()
    {
        var service = new RoadNetworkService(
            [new Source("overpass", 10, 50, fail: true), new Source("geofabrik", 50, 2500)],
            NullLogger<RoadNetworkService>.Instance);

        var answer = await service.FetchAsync(Small, TestContext.Current.CancellationToken);

        Assert.Equal("geofabrik", answer.Provider);
    }

    [Fact]
    public async Task Area_beyond_every_limit_is_rejected()
    {
        var service = new RoadNetworkService([new Source("overpass", 10, 50)], NullLogger<RoadNetworkService>.Instance);

        var ex = await Assert.ThrowsAsync<AreaTooLargeException>(() => service.FetchAsync(Large, TestContext.Current.CancellationToken));

        Assert.Contains("km²", ex.Message, StringComparison.Ordinal);
        Assert.NotNull(new AreaTooLargeException().Message);
        Assert.Equal("x", new AreaTooLargeException("x", new InvalidOperationException()).Message);
    }

    [Fact]
    public async Task No_source_configured_is_reported_as_unavailable()
    {
        var service = new RoadNetworkService([], NullLogger<RoadNetworkService>.Instance);

        await Assert.ThrowsAsync<NoProviderAvailableException>(() => service.FetchAsync(Small, TestContext.Current.CancellationToken));
        Assert.Equal(0, service.MaxAreaSquareKilometers);
    }
}
