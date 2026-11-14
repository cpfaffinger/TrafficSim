using TrafficSim.Application.Networks;
using TrafficSim.Application.Scenarios;
using TrafficSim.Domain.Editing;
using TrafficSim.Domain.Geo;
using TrafficSim.Domain.Osm;

namespace TrafficSim.Application.Tests.Scenarios;

public class ScenarioServiceTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<(ScenarioService Service, Guid BaselineId, InMemoryNetworkBaselineStore Store)> CreateAsync(bool withOsm = true)
    {
        var store = new InMemoryNetworkBaselineStore();
        var area = new BoundingBox(48.2, 16.36, 48.21, 16.375);
        var c = area.Center;
        var osm = new OsmDataSet(
            [new OsmNode(1, new GeoPoint(c.Latitude, c.Longitude - 0.002)), new OsmNode(2, new GeoPoint(c.Latitude, c.Longitude + 0.002))],
            [new OsmWay(10, [1, 2], OsmTags.Of(("highway", "primary")))]);
        var id = Guid.NewGuid();
        await store.SaveAsync(new NetworkBaselineInfo(id, area, DateTimeOffset.UnixEpoch, "test", null, new PackageStats(2, 2, 2, 0, 0), ["© OSM"]), [1], withOsm ? OsmDataCodec.Encode(osm) : null, Ct);
        return (new ScenarioService(store, new InMemoryScenarioStore(), new InMemoryRunStore(), TimeProvider.System), id, store);
    }

    [Fact]
    public async Task Compile_applies_changeset_and_caches_by_content()
    {
        var (service, baselineId, _) = await CreateAsync();
        EditOperation[] ops = [new SetWayTags(10, null, null, new Dictionary<string, string?> { ["lanes"] = "6" })];

        var first = await service.CompileAsync(baselineId, ops, Ct);
        var second = await service.CompileAsync(baselineId, [new SetWayTags(10, null, null, new Dictionary<string, string?> { ["lanes"] = "6" })], Ct);

        var package = NetworkPackageWriter.DeserializeGzip(first.GzipPackage);
        Assert.All(package.Links, l => Assert.Equal(3, l.Lanes.Count));
        Assert.Same(first.GzipPackage, second.GzipPackage);
        Assert.Equal([1], (await service.CompileAsync(baselineId, [], Ct)).GzipPackage);
        Assert.Equal(ScenarioService.CacheKey(baselineId, ops), ScenarioService.CacheKey(baselineId, [.. ops]));
    }

    [Fact]
    public async Task Baselines_without_osm_data_cannot_be_edited()
    {
        var (service, baselineId, _) = await CreateAsync(withOsm: false);

        await Assert.ThrowsAsync<NotFoundException>(() => service.CompileAsync(baselineId, [new RemoveWay(10, null, null)], Ct));
        await Assert.ThrowsAsync<NotFoundException>(() => service.CompileAsync(Guid.NewGuid(), [], Ct));
    }

    [Fact]
    public async Task Validation_of_scenario_fields()
    {
        var (service, baselineId, _) = await CreateAsync();

        await Assert.ThrowsAsync<ArgumentException>(() => service.CreateAsync(new string('x', 121), baselineId, null, null, null, null, Ct));
        await Assert.ThrowsAsync<ArgumentException>(() => service.CreateAsync("ok", baselineId, null, "{not json", null, null, Ct));
        await Assert.ThrowsAsync<ArgumentException>(() => service.CreateAsync("ok", baselineId, null, null, null, -1, Ct));
        await Assert.ThrowsAsync<NotFoundException>(() => service.CreateAsync("ok", Guid.NewGuid(), null, null, null, null, Ct));
        var ex = await Assert.ThrowsAsync<ChangesetValidationException>(() => service.CreateAsync("ok", baselineId, [new RemoveWay(1, null, null)], null, null, null, Ct));
        Assert.Single(ex.Issues);

        var s = await service.CreateAsync("  ok  ", baselineId, null, "{}", null, null, Ct);
        Assert.Equal("ok", s.Name);
        Assert.Equal(3600, s.DurationSeconds);
        Assert.Equal(1, s.Seed);
        var u = await service.UpdateAsync(s.Id, null, [new SetWayTags(10, null, null, new Dictionary<string, string?> { ["name"] = "A" })], "[]", 5, 60, Ct);
        Assert.Equal((5L, 60.0, "[]"), (u.Seed, u.DurationSeconds, u.DemandJson));
        Assert.Single(u.Changeset);

        await Assert.ThrowsAsync<ArgumentException>(() => service.AddRunAsync(s.Id, 1, 1, "{}", "", [], Ct));
        await Assert.ThrowsAsync<ArgumentException>(() => service.AddRunAsync(s.Id, 1, 1, "{}", "f", new byte[ScenarioService.MaxBucketBytes + 1], Ct));
        Assert.NotNull(new NotFoundException().Message);
        Assert.Equal("m", new NotFoundException("m", new InvalidOperationException()).Message);
    }
}
