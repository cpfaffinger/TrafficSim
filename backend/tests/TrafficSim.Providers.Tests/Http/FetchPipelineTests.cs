using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using TrafficSim.Application.Providers;
using TrafficSim.Providers.Http;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.Http;

public class FetchPipelineTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Rate_limiter_spaces_requests()
    {
        using var limiter = ProviderHttpClientRegistration.CreateRateLimiter(20); // one token per 50 ms
        var stub = StubHttpMessageHandler.Json("{}");
        using var client = new HttpClient(new RateLimitingHandler(limiter) { InnerHandler = stub });
        var watch = Stopwatch.StartNew();

        for (var i = 0; i < 4; i++)
        {
            using var _ = await client.GetAsync(new Uri("http://x.test/"), Ct);
        }

        Assert.Equal(4, stub.Requests.Count);
        Assert.True(watch.ElapsedMilliseconds >= 120, $"elapsed {watch.ElapsedMilliseconds} ms");
    }

    [Fact]
    public async Task Rate_limiter_answers_429_when_queue_is_exhausted()
    {
        using var limiter = new System.Threading.RateLimiting.ConcurrencyLimiter(new() { PermitLimit = 1, QueueLimit = 0 });
        using var held = await limiter.AcquireAsync(1, Ct);
        using var client = new HttpClient(new RateLimitingHandler(limiter) { InnerHandler = StubHttpMessageHandler.Json("{}") });

        using var response = await client.GetAsync(new Uri("http://x.test/"), Ct);

        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
    }

    [Fact]
    public void Rate_limiter_rejects_non_positive_rates() =>
        Assert.Throws<ArgumentOutOfRangeException>(() => ProviderHttpClientRegistration.CreateRateLimiter(0));

    [Fact]
    public async Task Telemetry_records_outcomes()
    {
        using var services = new ServiceCollection().AddMetrics().BuildServiceProvider();
        var metrics = new ProviderMetrics(services.GetRequiredService<IMeterFactory>());
        var outcomes = new List<string>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, l) =>
        {
            if (instrument.Meter.Name == ProviderMetrics.MeterName && instrument.Name == "trafficsim.provider.requests")
            {
                l.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((_, _, tags, _) =>
        {
            foreach (var tag in tags)
            {
                if (tag.Key == "outcome")
                {
                    outcomes.Add((string)tag.Value!);
                }
            }
        });
        listener.Start();

        var calls = 0;
        var stub = new StubHttpMessageHandler(_ => ++calls switch
        {
            1 => new HttpResponseMessage(HttpStatusCode.OK),
            2 => new HttpResponseMessage(HttpStatusCode.BadGateway),
            _ => throw new HttpRequestException("boom"),
        });
        using var client = new HttpClient(new ProviderTelemetryHandler("p", metrics, NullLogger<ProviderTelemetryHandler>.Instance) { InnerHandler = stub });

        (await client.GetAsync(new Uri("http://x.test/a"), Ct)).Dispose();
        (await client.GetAsync(new Uri("http://x.test/b"), Ct)).Dispose();
        await Assert.ThrowsAsync<HttpRequestException>(() => client.GetAsync(new Uri("http://x.test/c"), Ct));

        Assert.Equal(["success", "http_error", "exception"], outcomes);
    }

    [Fact]
    public async Task Cache_serves_repeated_get_requests_until_expiry()
    {
        using var dir = new TempDirectory();
        var time = new TestTime(DateTimeOffset.Parse("2026-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
        var cache = new FileResponseCache(dir.Path, time);
        var counter = 0;
        var stub = new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent($"{{\"n\":{++counter}}}", System.Text.Encoding.UTF8, "application/json"),
        });
        using var client = new HttpClient(new ResponseCacheHandler("p", TimeSpan.FromHours(1), cache) { InnerHandler = stub });
        var uri = new Uri("http://x.test/q?a=1");

        using var first = await client.GetAsync(uri, Ct);
        using var second = await client.GetAsync(uri, Ct);

        Assert.Equal("miss", first.Headers.GetValues(ResponseCacheHandler.CacheHeader).Single());
        Assert.Equal("hit", second.Headers.GetValues(ResponseCacheHandler.CacheHeader).Single());
        Assert.Equal("{\"n\":1}", await second.Content.ReadAsStringAsync(Ct));
        Assert.Equal("application/json", second.Content.Headers.ContentType?.MediaType);
        Assert.Single(stub.Requests);

        time.Advance(TimeSpan.FromHours(2));
        using var third = await client.GetAsync(uri, Ct);
        Assert.Equal("{\"n\":2}", await third.Content.ReadAsStringAsync(Ct));
    }

    [Fact]
    public async Task Cache_ignores_errors_and_non_get_requests()
    {
        using var dir = new TempDirectory();
        var cache = new FileResponseCache(dir.Path, TimeProvider.System);
        var stub = new StubHttpMessageHandler(r => new HttpResponseMessage(r.Method == HttpMethod.Get ? HttpStatusCode.BadGateway : HttpStatusCode.OK));
        using var client = new HttpClient(new ResponseCacheHandler("p", TimeSpan.FromHours(1), cache) { InnerHandler = stub });
        var uri = new Uri("http://x.test/q");

        (await client.GetAsync(uri, Ct)).Dispose();
        (await client.GetAsync(uri, Ct)).Dispose();
        (await client.PostAsync(uri, new StringContent("x"), Ct)).Dispose();
        (await client.PostAsync(uri, new StringContent("x"), Ct)).Dispose();

        Assert.Equal(4, stub.Requests.Count);
        Assert.Null(await cache.GetAsync(FileResponseCache.Key("p", uri), Ct));
    }

    [Fact]
    public async Task Corrupt_cache_entries_are_misses()
    {
        using var dir = new TempDirectory();
        var cache = new FileResponseCache(dir.Path, TimeProvider.System);
        var key = FileResponseCache.Key("p", new Uri("http://x.test/"));
        await cache.SetAsync(key, new CachedResponse([1, 2, 3], null), TimeSpan.FromHours(1), Ct);
        foreach (var meta in Directory.GetFiles(dir.Path, "*.json", SearchOption.AllDirectories))
        {
            await File.WriteAllTextAsync(meta, "not json", Ct);
        }

        Assert.Null(await cache.GetAsync(key, Ct));
        Assert.Null(await cache.GetAsync("p/unknown", Ct));
    }

    [Fact]
    public void Cache_keys_are_per_provider_and_url()
    {
        var a = FileResponseCache.Key("a", new Uri("http://x.test/1"));
        Assert.StartsWith("a/", a, StringComparison.Ordinal);
        Assert.NotEqual(a, FileResponseCache.Key("b", new Uri("http://x.test/1")));
        Assert.NotEqual(a, FileResponseCache.Key("a", new Uri("http://x.test/2")));
    }

    [Fact]
    public async Task Registered_pipeline_caches_and_rate_limits_nominatim()
    {
        using var dir = new TempDirectory();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Providers:Cache:Directory"] = dir.Path,
            ["Providers:Photon:Enabled"] = "false",
            ["Providers:Overpass:Enabled"] = "false",
            ["Providers:Nominatim:BaseUrl"] = "https://nominatim.test/",
        }).Build();
        var stub = StubHttpMessageHandler.Json("""{"lat":"48.2","lon":"16.37","display_name":"Ring","category":"highway","type":"primary"}""");
        var services = new ServiceCollection().AddLogging();
        services.AddTrafficSimProviders(configuration);
        services.AddHttpClient<TrafficSim.Providers.Nominatim.NominatimProvider>("nominatim").ConfigurePrimaryHttpMessageHandler(() => stub);
        using var provider = services.BuildServiceProvider();
        var reverse = Assert.Single(provider.GetServices<IReverseGeocodingProvider>());
        var query = new TrafficSim.Application.Geocoding.ReverseGeocodeQuery(new TrafficSim.Domain.Geo.GeoPoint(48.2, 16.37));

        var first = await reverse.ReverseAsync(query, Ct);
        var second = await reverse.ReverseAsync(query, Ct);

        Assert.Equal("Ring", first!.Label);
        Assert.Equal("Ring", second!.Label);
        Assert.Single(stub.Requests);
        Assert.NotEmpty(Directory.GetFiles(dir.Path, "*.body", SearchOption.AllDirectories));
    }
}
