using Microsoft.EntityFrameworkCore;
using TrafficSim.Application.Networks;
using TrafficSim.Application.Scenarios;
using TrafficSim.Domain.Editing;
using TrafficSim.Domain.Geo;
using TrafficSim.Infrastructure.Persistence;

namespace TrafficSim.Infrastructure.Tests;

public class EfScenarioStoreTests(PostGisFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Scenarios_and_runs_round_trip()
    {
        await using (var migrate = db.CreateContext())
        {
            await migrate.Database.MigrateAsync(Ct);
        }

        var baselineId = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        await using (var context = db.CreateContext())
        {
            await new EfNetworkBaselineStore(context).SaveAsync(
                new NetworkBaselineInfo(baselineId, new BoundingBox(1, 1, 2, 2), now, "t", null, new PackageStats(0, 0, 0, 0, 0), []), [1], null, Ct);
        }

        var scenario = new Scenario(Guid.NewGuid(), "S", baselineId, null,
            [new SetWayTags(10, null, null, new Dictionary<string, string?> { ["lanes"] = "3" }), new ConvertToRoundabout(2, 12)],
            """{"a":1}""", 9, 600, "token-" + Guid.NewGuid().ToString("N"), now, now);
        await using (var context = db.CreateContext())
        {
            var store = new EfScenarioStore(context);
            await store.SaveAsync(scenario, Ct);
            await store.SaveAsync(scenario with { Name = "S2" }, Ct); // update path
        }

        await using (var context = db.CreateContext())
        {
            var store = new EfScenarioStore(context);
            var loaded = await store.GetAsync(scenario.Id, Ct);
            Assert.Equal("S2", loaded!.Name);
            Assert.IsType<ConvertToRoundabout>(loaded.Changeset[1]);
            Assert.Equal(scenario.Id, (await store.GetByShareTokenAsync(scenario.ShareToken, Ct))!.Id);
            Assert.Single(await store.ListAsync(baselineId, 10, Ct));
            Assert.NotEmpty(await store.ListAsync(null, 10, Ct));

            var runs = new EfRunStore(context);
            var run = new SimulationRun(Guid.NewGuid(), scenario.Id, 3, 600, """{"v":1}""", "lane-cells-v1", now);
            await runs.SaveAsync(run, [5, 6], Ct);
            var loadedRun = (await runs.GetAsync(run.Id, Ct))!;
            Assert.Equal((run.Seed, run.SimulatedSeconds, run.BucketFormat), (loadedRun.Seed, loadedRun.SimulatedSeconds, loadedRun.BucketFormat));
            Assert.Equal([5, 6], await runs.GetBucketsAsync(run.Id, Ct));
            Assert.Single(await runs.ListAsync(scenario.Id, Ct));

            Assert.True(await store.DeleteAsync(scenario.Id, Ct));
            Assert.False(await store.DeleteAsync(scenario.Id, Ct));
            Assert.Null(await runs.GetAsync(run.Id, Ct)); // cascade
        }
    }
}
