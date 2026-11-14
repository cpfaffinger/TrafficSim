using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TrafficSim.Application.Providers;
using TrafficSim.Domain.Geo;
using TrafficSim.Providers.TerrainTiles;
using TrafficSim.Providers.Tests.Support;

namespace TrafficSim.Providers.Tests.TerrainTiles;

/// <summary>Terrarium tile adapter (#87, ADR-0018): PNG decoding, tile math, sampling and failures.</summary>
public class TerrainTilesElevationProviderTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Recorded-style fixture: a z13 tile encoded by Pillow, heights 300.125 + 0.5·x − 0.25·y (pixels).</summary>
    private static readonly byte[] PlaneTile = File.ReadAllBytes(Fixtures.Path("terraintiles", "terrarium-plane.png"));

    private static readonly GeoPoint Vienna = new(48.205, 16.3675); // inside z13 tile 4468/2840

    private static TerrainTilesElevationProvider Provider(HttpMessageHandler handler, Action<TerrainTilesOptions>? configure = null) =>
        new(ProviderFactory.Client(handler, "https://tiles.test/elevation/"), ProviderFactory.Options(o => configure?.Invoke(o.TerrainTiles)));

    private static StubHttpMessageHandler Png(byte[] png) =>
        new(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(png) });

    [Fact]
    public void Decodes_a_third_party_encoded_tile()
    {
        var tile = TerrariumPng.Decode(PlaneTile);

        Assert.Equal(256, tile.Width);
        Assert.Equal(256, tile.Height);
        Assert.Equal(300.125, tile.At(0, 0), 3);
        Assert.Equal(300.125 + 50 - 25, tile.At(100, 100), 3);
        Assert.Equal(300.125 + 127.5 - 63.75, tile.At(255, 255), 3);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Decodes_every_filter_type_with_and_without_alpha(bool alpha)
    {
        static double Height(int x, int y) => -12.5 + (x * 7.25) - (y * 3.5) + ((x * y) % 13);
        var png = TerrariumPngWriter.Encode(17, 11, Height, alpha);

        var tile = TerrariumPng.Decode(png);

        for (var y = 0; y < 11; y++)
        {
            for (var x = 0; x < 17; x++)
            {
                Assert.Equal(Height(x, y), tile.At(x, y), 2);
            }
        }
    }

    [Fact]
    public void Rejects_broken_and_unsupported_pngs()
    {
        Assert.Throws<InvalidDataException>(() => TerrariumPng.Decode("not a png"u8));
        var png = TerrariumPngWriter.Encode(4, 4, (_, _) => 0);
        Assert.Throws<InvalidDataException>(() => TerrariumPng.Decode(png.AsSpan(0, 40)));
        var paletted = (byte[])png.Clone();
        paletted[8 + 8 + 9] = 3; // IHDR colour type → palette
        Assert.Throws<InvalidDataException>(() => TerrariumPng.Decode(paletted));
    }

    [Fact]
    public void Tile_math_matches_the_slippy_map_scheme()
    {
        var (x, y) = TerrainTilesElevationProvider.PixelOf(Vienna, 13);

        Assert.Equal(4468, (int)(x / 256));
        Assert.Equal(2840, (int)(y / 256));
        Assert.Equal((128, 128), ((int)TerrainTilesElevationProvider.PixelOf(new GeoPoint(0, 0), 0).X, (int)TerrainTilesElevationProvider.PixelOf(new GeoPoint(0, 0), 0).Y));
    }

    [Fact]
    public async Task Samples_heights_bilinearly_from_the_covering_tile()
    {
        var handler = Png(PlaneTile);
        var provider = Provider(handler);
        var east = new GeoPoint(48.205, 16.3685);

        var heights = await provider.SampleAsync([Vienna, east], Ct);

        var request = Assert.Single(handler.Requests);
        Assert.Equal("https://tiles.test/elevation/terrarium/13/4468/2840.png", request.RequestUri!.AbsoluteUri);
        foreach (var (point, height) in new[] { Vienna, east }.Zip(heights))
        {
            var (px, py) = TerrainTilesElevationProvider.PixelOf(point, 13);
            var lx = px - (4468 * 256) - 0.5;
            var ly = py - (2840 * 256) - 0.5;
            Assert.Equal(300.125 + (0.5 * lx) - (0.25 * ly), height!.Value, 2);
        }

        Assert.Empty(await provider.SampleAsync([], Ct));
    }

    [Fact]
    public async Task Lowers_the_zoom_for_large_areas()
    {
        var handler = Png(TerrariumPngWriter.Encode(256, 256, (_, _) => 100));
        var provider = Provider(handler, o => o.MaxTiles = 4);
        GeoPoint[] corners = [new(48.0, 16.0), new(48.3, 16.6)];

        var heights = await provider.SampleAsync(corners, Ct);

        Assert.InRange(handler.Requests.Count, 1, 4);
        Assert.All(handler.Requests, r => Assert.StartsWith("https://tiles.test/elevation/terrarium/9/", r.RequestUri!.AbsoluteUri, StringComparison.Ordinal));
        Assert.All(heights, h => Assert.Equal(100, h!.Value, 3));
        Assert.Equal(13, TerrainTilesElevationProvider.ZoomFor([Vienna], 13, 64));
        Assert.Equal(15, TerrainTilesElevationProvider.ZoomFor([Vienna], 99, 64));
    }

    [Fact]
    public async Task Missing_tiles_give_null_heights()
    {
        var provider = Provider(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound)));

        var heights = await provider.SampleAsync([Vienna], Ct);

        Assert.Null(Assert.Single(heights));
    }

    [Fact]
    public async Task Server_errors_and_corrupt_tiles_make_the_provider_unavailable()
    {
        var down = Provider(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)));
        var corrupt = Provider(Png("garbage"u8.ToArray()));
        var unreachable = Provider(StubHttpMessageHandler.Throws(new HttpRequestException("no route")));

        Assert.Contains("HTTP 503", (await Assert.ThrowsAsync<ProviderUnavailableException>(() => down.SampleAsync([Vienna], Ct))).Message, StringComparison.Ordinal);
        Assert.Contains("invalid tile", (await Assert.ThrowsAsync<ProviderUnavailableException>(() => corrupt.SampleAsync([Vienna], Ct))).Message, StringComparison.Ordinal);
        await Assert.ThrowsAsync<ProviderUnavailableException>(() => unreachable.SampleAsync([Vienna], Ct));
    }

    [Fact]
    public void Is_registered_by_default_and_can_be_disabled()
    {
        static ServiceProvider Build(Dictionary<string, string?> settings)
        {
            var services = new ServiceCollection().AddLogging();
            services.AddTrafficSimProviders(new ConfigurationBuilder().AddInMemoryCollection(settings).Build());
            return services.BuildServiceProvider();
        }

        using (var enabled = Build([]))
        {
            var provider = Assert.IsType<TerrainTilesElevationProvider>(Assert.Single(enabled.GetServices<IElevationProvider>()));
            Assert.Equal(TerrainTilesElevationProvider.AttributionText, provider.Attribution);
            var entry = enabled.GetRequiredService<IProviderCatalog>().Providers.Single(p => p.Name == "terrain-tiles");
            Assert.Equal([ProviderCapability.Elevation], entry.Capabilities);
            Assert.True(entry.Enabled);
            Assert.Equal(new Uri("https://s3.amazonaws.com/elevation-tiles-prod/"), entry.Endpoint);
        }

        using var disabled = Build(new() { ["Providers:TerrainTiles:Enabled"] = "false" });
        Assert.Empty(disabled.GetServices<IElevationProvider>());
        Assert.False(disabled.GetRequiredService<IProviderCatalog>().Providers.Single(p => p.Name == "terrain-tiles").Enabled);
    }
}
