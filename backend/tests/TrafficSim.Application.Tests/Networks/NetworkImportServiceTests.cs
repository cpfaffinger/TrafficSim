using Microsoft.Extensions.Logging.Abstractions;
using TrafficSim.Application.Networks;
using TrafficSim.Application.Providers;
using TrafficSim.Application.RoadSources;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Tests.Networks;

public class NetworkImportServiceTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly BoundingBox Area = new(48.200001, 16.360001, 48.210001, 16.375001);

    private sealed class Source(Func<OsmDataSet> data, double maxArea = 50) : IRoadNetworkSource
    {
        public int Calls { get; private set; }

        public string Name => "fake-source";

        public int Priority => 1;

        public string Attribution => "Fake data";

        public double MaxAreaSquareKilometers => maxArea;

        public Task<OsmDataSet> FetchAsync(BoundingBox area, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(data());
        }
    }

    private static OsmDataSet Street(BoundingBox area)
    {
        var c = area.Center;
        return new OsmDataSet(
            [new OsmNode(1, new GeoPoint(c.Latitude, c.Longitude - 0.002)), new OsmNode(2, new GeoPoint(c.Latitude, c.Longitude + 0.002))],
            [new OsmWay(10, [1, 2], OsmTags.Of(("highway", "primary")))],
            DateTimeOffset.UnixEpoch);
    }

    private static (NetworkImportService Service, Source Source, InMemoryNetworkBaselineStore Store, ChannelImportQueue Queue) Create(Func<OsmDataSet>? data = null)
    {
        var source = new Source(data ?? (() => Street(Area)));
        var store = new InMemoryNetworkBaselineStore();
        var queue = new ChannelImportQueue();
        var service = new NetworkImportService(
            new RoadNetworkService([source], NullLogger<RoadNetworkService>.Instance),
            store, new InMemoryImportJobStore(), queue, TimeProvider.System, NullLogger<NetworkImportService>.Instance);
        return (service, source, store, queue);
    }

    [Fact]
    public async Task Import_fetches_compiles_and_stores_a_baseline()
    {
        var (service, source, store, _) = Create();

        var job = await service.StartAsync(Area, Ct);
        Assert.Equal(ImportStatus.Queued, job.Status);
        Assert.Equal(48.2, job.Area.South); // normalised to 5 decimals
        await service.RunAsync(job.Id, Ct);

        var done = await service.GetJobAsync(job.Id, Ct);
        Assert.Equal(ImportStatus.Completed, done!.Status);
        var info = await store.GetAsync(done.BaselineId!.Value, Ct);
        Assert.Equal("fake-source", info!.Source);
        Assert.Equal(2, info.Stats.Links);
        Assert.Contains(NetworkImportService.OsmAttribution, info.Attribution);
        Assert.Contains("Fake data", info.Attribution);
        var package = NetworkPackageWriter.DeserializeGzip((await store.GetPackageAsync(info.Id, Ct))!);
        Assert.Equal(info.Id, package.BaselineId);
        Assert.Equal(1, source.Calls);
        Assert.Single(await store.ListAsync(10, Ct));

        // Running again is a no-op; the same area is reused within the window.
        await service.RunAsync(job.Id, Ct);
        var again = await service.StartAsync(Area, Ct);
        Assert.Equal(ImportStatus.Completed, again.Status);
        Assert.Equal(info.Id, again.BaselineId);
        Assert.Equal(1, source.Calls);
    }

    [Fact]
    public async Task Failures_are_recorded_on_the_job()
    {
        var (service, _, _, _) = Create(() => throw new ProviderUnavailableException("fake-source", "down"));

        var job = await service.StartAsync(Area, Ct);
        await service.RunAsync(job.Id, Ct);

        var failed = await service.GetJobAsync(job.Id, Ct);
        Assert.Equal(ImportStatus.Failed, failed!.Status);
        Assert.Contains("failed", failed.Error, StringComparison.Ordinal);
        await service.RunAsync(Guid.NewGuid(), Ct); // unknown job: ignored
    }

    [Fact]
    public async Task Rejects_too_small_and_too_large_areas()
    {
        var (service, _, _, _) = Create();

        await Assert.ThrowsAsync<InvalidImportAreaException>(() => service.StartAsync(new BoundingBox(48.2, 16.36, 48.2001, 16.3601), Ct));
        await Assert.ThrowsAsync<AreaTooLargeException>(() => service.StartAsync(new BoundingBox(47, 15, 49, 17), Ct));
        Assert.Equal("x", new InvalidImportAreaException("x").Message);
        Assert.NotNull(new InvalidImportAreaException().Message);
        Assert.Equal("x", new InvalidImportAreaException("x", new InvalidOperationException()).Message);
    }

    [Fact]
    public async Task Queue_delivers_enqueued_jobs()
    {
        var (service, _, _, queue) = Create();
        var job = await service.StartAsync(Area, Ct);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(Ct);

        await foreach (var id in queue.DequeueAllAsync(cts.Token))
        {
            Assert.Equal(job.Id, id);
            break;
        }
    }
}
