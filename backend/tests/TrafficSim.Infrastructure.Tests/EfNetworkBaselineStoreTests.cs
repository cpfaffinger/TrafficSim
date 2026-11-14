using Microsoft.EntityFrameworkCore;
using TrafficSim.Application.Networks;
using TrafficSim.Domain.Geo;
using TrafficSim.Infrastructure.Persistence;

namespace TrafficSim.Infrastructure.Tests;

public class EfNetworkBaselineStoreTests(PostGisFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Stores_lists_finds_and_serves_packages()
    {
        db.RequireDatabase();
        var area = new BoundingBox(48.2, 16.36, 48.21, 16.375);
        var now = DateTimeOffset.UtcNow;
        var info = new NetworkBaselineInfo(Guid.NewGuid(), area, now, "overpass", now.AddHours(-1), new PackageStats(1, 2, 3, 4, 5), ["© OSM", "Overpass"]);
        byte[] package = [1, 2, 3];

        await using (var context = db.CreateContext())
        {
            await new EfNetworkBaselineStore(context).SaveAsync(info, package, [9, 9], Ct);
        }

        await using var read = db.CreateContext();
        var store = new EfNetworkBaselineStore(read);
        var loaded = await store.GetAsync(info.Id, Ct);
        Assert.NotNull(loaded);
        Assert.Equal(area, loaded.Area);
        Assert.Equal(info.Stats, loaded.Stats);
        Assert.Equal(info.Attribution, loaded.Attribution);
        Assert.Equal(package, await store.GetPackageAsync(info.Id, Ct));
        Assert.Null(await store.GetPackageAsync(Guid.NewGuid(), Ct));
        Assert.Equal([9, 9], await store.GetOsmDataAsync(info.Id, Ct));
        Assert.Null(await store.GetAsync(Guid.NewGuid(), Ct));
        Assert.Contains(await store.ListAsync(10, Ct), i => i.Id == info.Id);
        Assert.Equal(info.Id, (await store.FindRecentAsync(area, null, now.AddMinutes(-1), Ct))?.Id);
        Assert.Null(await store.FindRecentAsync(area, null, now.AddMinutes(1), Ct));
        Assert.Null(await store.FindRecentAsync(new BoundingBox(-40, -40, -39, -39), null, now.AddDays(-1), Ct));

        var polygon = EfNetworkBaselineStore.ToPolygon(area);
        Assert.Equal(4326, polygon.SRID);
        Assert.True(polygon.IsValid);
    }
}
