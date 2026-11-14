using TrafficSim.Providers.Photon;

namespace TrafficSim.Providers.Tests.Photon;

public class PhotonMapperTests
{
    [Fact]
    public void Label_falls_back_when_no_parts_exist() =>
        Assert.Equal("Unnamed place", PhotonMapper.BuildLabel(new PhotonProperties()));

    [Fact]
    public void Label_combines_postcode_without_city() =>
        Assert.Equal("Main St, 1010", PhotonMapper.BuildLabel(new PhotonProperties { Name = "Main St", Postcode = "1010" }));

    [Fact]
    public void Label_deduplicates_identical_parts() =>
        Assert.Equal("Wien, Österreich", PhotonMapper.BuildLabel(new PhotonProperties { Name = "Wien", City = "Wien", State = "Wien", Country = "Österreich" }));

    [Theory]
    [InlineData(null)]
    [InlineData(new double[] { 1, 2, 3 })]
    [InlineData(new double[] { 16.4, 48.2, 16.3, 48.1 })] // west > east
    [InlineData(new double[] { 16.3, 48.1, 16.4, 48.2 })] // south > north (extent order swapped)
    [InlineData(new double[] { 200, 48.2, 201, 48.1 })] // out of range
    public void Invalid_extents_are_ignored(double[]? extent) =>
        Assert.Null(PhotonMapper.MapExtent(extent));

    [Theory]
    [InlineData("N", 1L, "node/1")]
    [InlineData("W", 2L, "way/2")]
    [InlineData("R", 3L, "relation/3")]
    [InlineData("X", 4L, null)]
    [InlineData("N", null, null)]
    public void Maps_osm_reference(string type, long? id, string? expected) =>
        Assert.Equal(expected, PhotonMapper.MapOsmReference(type, id));

    [Fact]
    public void Category_defaults_when_osm_key_is_missing()
    {
        var feature = new PhotonFeature(new PhotonGeometry("Point", [16.37, 48.2]), null);

        var result = PhotonMapper.Map(feature);

        Assert.NotNull(result);
        Assert.Equal("unknown", result.Category);
        Assert.Equal("Unnamed place", result.Label);
    }

    [Fact]
    public void Features_with_out_of_range_coordinates_are_skipped() =>
        Assert.Null(PhotonMapper.Map(new PhotonFeature(new PhotonGeometry("Point", [16.37, 95]), null)));

    [Fact]
    public void Null_collection_maps_to_empty_list() =>
        Assert.Empty(PhotonMapper.Map((PhotonFeatureCollection?)null));
}
