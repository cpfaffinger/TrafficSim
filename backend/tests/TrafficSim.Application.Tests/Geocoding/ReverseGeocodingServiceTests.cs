using Microsoft.Extensions.Logging.Abstractions;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Application.Tests.Geocoding;

public class ReverseGeocodingServiceTests
{
    private sealed class Fake(string name, int priority, GeocodeResult? result, bool fail = false) : IReverseGeocodingProvider
    {
        public string Name => name;

        public int Priority => priority;

        public string Attribution => $"attr {name}";

        public Task<GeocodeResult?> ReverseAsync(ReverseGeocodeQuery query, CancellationToken cancellationToken) =>
            fail ? throw new ProviderUnavailableException(name, "down") : Task.FromResult(result);
    }

    private static readonly ReverseGeocodeQuery Query = new(new GeoPoint(48.2, 16.37), " DE ");

    [Fact]
    public void Query_normalises_language()
    {
        Assert.Equal("de", Query.Language);
        Assert.Null(new ReverseGeocodeQuery(new GeoPoint(0, 0), " ").Language);
    }

    [Fact]
    public async Task Falls_back_to_next_provider()
    {
        var result = new GeocodeResult("Ring", new GeoPoint(48.2, 16.37), "highway:primary");
        var service = new ReverseGeocodingService(
            [new Fake("b", 2, result), new Fake("a", 1, null, fail: true)],
            NullLogger<ReverseGeocodingService>.Instance);

        var response = await service.ReverseAsync(Query, TestContext.Current.CancellationToken);

        Assert.Equal("b", response.Provider);
        Assert.Equal("Ring", response.Result!.Label);
    }

    [Fact]
    public async Task Null_result_is_a_valid_answer()
    {
        var service = new ReverseGeocodingService([new Fake("a", 1, null)], NullLogger<ReverseGeocodingService>.Instance);

        var response = await service.ReverseAsync(Query, TestContext.Current.CancellationToken);

        Assert.Null(response.Result);
        Assert.Equal("a", response.Provider);
    }
}
