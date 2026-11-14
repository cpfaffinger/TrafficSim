using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace TrafficSim.Infrastructure.Persistence;

public sealed class ScenarioEntity
{
    public Guid Id { get; set; }

    public required string Name { get; set; }

    public Guid BaselineId { get; set; }

    public Guid? ParentId { get; set; }

    public required string Changeset { get; set; }

    public string? Demand { get; set; }

    public long Seed { get; set; }

    public double DurationSeconds { get; set; }

    public required string ShareToken { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class RunEntity
{
    public Guid Id { get; set; }

    public Guid ScenarioId { get; set; }

    public long Seed { get; set; }

    public double SimulatedSeconds { get; set; }

    public required string Summary { get; set; }

    public required string BucketFormat { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public required byte[] Buckets { get; set; }
}

internal sealed class ScenarioConfiguration : IEntityTypeConfiguration<ScenarioEntity>
{
    public void Configure(EntityTypeBuilder<ScenarioEntity> builder)
    {
        builder.ToTable("scenarios");
        builder.HasKey(s => s.Id);
        builder.Property(s => s.Name).HasMaxLength(120);
        builder.Property(s => s.Changeset).HasColumnType("jsonb");
        builder.Property(s => s.Demand).HasColumnType("jsonb");
        builder.Property(s => s.ShareToken).HasMaxLength(64);
        builder.HasIndex(s => s.ShareToken).IsUnique();
        builder.HasIndex(s => new { s.BaselineId, s.UpdatedAt });
        builder.HasOne<NetworkBaselineEntity>().WithMany().HasForeignKey(s => s.BaselineId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class RunConfiguration : IEntityTypeConfiguration<RunEntity>
{
    public void Configure(EntityTypeBuilder<RunEntity> builder)
    {
        builder.ToTable("simulation_runs");
        builder.HasKey(r => r.Id);
        builder.Property(r => r.Summary).HasColumnType("jsonb");
        builder.Property(r => r.BucketFormat).HasMaxLength(64);
        builder.HasIndex(r => new { r.ScenarioId, r.CreatedAt });
        builder.HasOne<ScenarioEntity>().WithMany().HasForeignKey(r => r.ScenarioId).OnDelete(DeleteBehavior.Cascade);
    }
}
