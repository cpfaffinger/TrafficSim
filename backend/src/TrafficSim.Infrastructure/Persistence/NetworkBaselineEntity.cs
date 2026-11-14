using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using NetTopologySuite.Geometries;

namespace TrafficSim.Infrastructure.Persistence;

/// <summary>Row of <c>network_baselines</c>: an immutable compiled network with its gzip package.</summary>
public sealed class NetworkBaselineEntity
{
    public Guid Id { get; set; }

    public required Polygon Area { get; set; }

    public double South { get; set; }

    public double West { get; set; }

    public double North { get; set; }

    public double East { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public required string Source { get; set; }

    public DateTimeOffset? OsmTimestamp { get; set; }

    public int Nodes { get; set; }

    public int Links { get; set; }

    public int Lanes { get; set; }

    public int Connectors { get; set; }

    public int Signals { get; set; }

    public List<string> Attribution { get; set; } = [];

    public required byte[] Package { get; set; }
}

internal sealed class NetworkBaselineConfiguration : IEntityTypeConfiguration<NetworkBaselineEntity>
{
    public void Configure(EntityTypeBuilder<NetworkBaselineEntity> builder)
    {
        builder.ToTable("network_baselines");
        builder.HasKey(b => b.Id);
        builder.Property(b => b.Area).HasColumnType("geometry(Polygon,4326)");
        builder.HasIndex(b => b.Area).HasMethod("gist");
        builder.HasIndex(b => b.CreatedAt);
        builder.HasIndex(b => new { b.South, b.West, b.North, b.East });
        builder.Property(b => b.Source).HasMaxLength(64);
    }
}
