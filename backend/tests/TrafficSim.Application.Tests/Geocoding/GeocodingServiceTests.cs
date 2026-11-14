using Microsoft.Extensions.Logging.Abstractions;
using TrafficSim.Application.Geocoding;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Geocoding;

namespace TrafficSim.Application.Tests.Geocoding;

public class GeocodingServiceTests
{
    private static readonly GeocodeQuery Query = new("Stephansplatz");

    [Fact]
    public async Task Uses_provider_with_lowest_priority_value_first()
    {
        var low = new FakeProvider("low", 1, Result("from-low"));
        var high = new FakeProvider("high", 50, Result("from-high"));
        var service = CreateService(high, low);

        var response = await service.SearchAsync(Query, TestContext.Current.CancellationToken);

        Assert.Equal("low", response.Provider);
        Assert.Equal("from-low", Assert.Single(response.Results).Label);
        Assert.Equal(0, high.Calls);
    }

    [Fact]
    public async Task Falls_back_when_a_provider_is_unavailable()
    {
        var failing = new FakeProvider("failing", 1, failure: new ProviderUnavailableException("failing", "HTTP 503"));
        var backup = new FakeProvider("backup", 2, Result("from-backup"));
        var service = CreateService(failing, backup);

        var response = await service.SearchAsync(Query, TestContext.Current.CancellationToken);

        Assert.Equal("backup", response.Provider);
        Assert.Equal("attribution backup", response.Attribution);
        Assert.Equal(1, failing.Calls);
    }

    [Fact]
    public async Task Empty_result_is_returned_without_fallback()
    {
        var empty = new FakeProvider("empty", 1);
        var backup = new FakeProvider("backup", 2, Result("from-backup"));
        var service = CreateService(empty, backup);

        var response = await service.SearchAsync(Query, TestContext.Current.CancellationToken);

        Assert.Empty(response.Results);
        Assert.Equal(0, backup.Calls);
    }

    [Fact]
    public async Task Throws_when_all_providers_fail()
    {
        var a = new FakeProvider("a", 1, failure: new ProviderUnavailableException("a", "down"));
        var b = new FakeProvider("b", 2, failure: new ProviderUnavailableException("b", "down"));
        var service = CreateService(a, b);

        var ex = await Assert.ThrowsAsync<NoProviderAvailableException>(
            () => service.SearchAsync(Query, TestContext.Current.CancellationToken));

        var inner = Assert.IsType<AggregateException>(ex.InnerException);
        Assert.Equal(2, inner.InnerExceptions.Count);
    }

    [Fact]
    public async Task Throws_when_no_provider_is_configured()
    {
        var service = CreateService();

        var ex = await Assert.ThrowsAsync<NoProviderAvailableException>(
            () => service.SearchAsync(Query, TestContext.Current.CancellationToken));

        Assert.Contains("No geocoding provider", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Does_not_swallow_unexpected_exceptions()
    {
        var broken = new FakeProvider("broken", 1, failure: new InvalidOperationException("bug"));
        var service = CreateService(broken, new FakeProvider("backup", 2, Result("x")));

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.SearchAsync(Query, TestContext.Current.CancellationToken));
    }

    [Fact]
    public void Exception_types_expose_standard_constructors()
    {
        Assert.Equal("unknown", new ProviderUnavailableException().ProviderName);
        Assert.Equal("m", new ProviderUnavailableException("m").Message);
        Assert.NotNull(new ProviderUnavailableException("m", new InvalidOperationException()).InnerException);
        Assert.Contains("'p'", new ProviderUnavailableException("p", "down", null).Message, StringComparison.Ordinal);
        Assert.NotNull(new NoProviderAvailableException().Message);
        Assert.Equal("m", new NoProviderAvailableException("m").Message);
    }

    private static GeocodingService CreateService(params IGeocodingProvider[] providers) =>
        new(providers, NullLogger<GeocodingService>.Instance);

    private static GeocodeResult Result(string label) => new(label, new GeoPoint(48.2, 16.37), "place:square");

    private sealed class FakeProvider(string name, int priority, GeocodeResult? result = null, Exception? failure = null)
        : IGeocodingProvider
    {
        public int Calls { get; private set; }

        public string Name => name;

        public int Priority => priority;

        public string Attribution => $"attribution {name}";

        public Task<IReadOnlyList<GeocodeResult>> SearchAsync(GeocodeQuery query, CancellationToken cancellationToken)
        {
            Calls++;
            if (failure is not null)
            {
                throw failure;
            }

            IReadOnlyList<GeocodeResult> results = result is null ? [] : [result];
            return Task.FromResult(results);
        }
    }
}
