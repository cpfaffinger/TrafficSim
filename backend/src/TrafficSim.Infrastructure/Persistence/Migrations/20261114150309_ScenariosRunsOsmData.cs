using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TrafficSim.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class ScenariosRunsOsmData : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<byte[]>(
                name: "osm_data",
                table: "network_baselines",
                type: "bytea",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "scenarios",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    baseline_id = table.Column<Guid>(type: "uuid", nullable: false),
                    parent_id = table.Column<Guid>(type: "uuid", nullable: true),
                    changeset = table.Column<string>(type: "jsonb", nullable: false),
                    demand = table.Column<string>(type: "jsonb", nullable: true),
                    seed = table.Column<long>(type: "bigint", nullable: false),
                    duration_seconds = table.Column<double>(type: "double precision", nullable: false),
                    share_token = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_scenarios", x => x.id);
                    table.ForeignKey(
                        name: "fk_scenarios_network_baselines_baseline_id",
                        column: x => x.baseline_id,
                        principalTable: "network_baselines",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "simulation_runs",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    scenario_id = table.Column<Guid>(type: "uuid", nullable: false),
                    seed = table.Column<long>(type: "bigint", nullable: false),
                    simulated_seconds = table.Column<double>(type: "double precision", nullable: false),
                    summary = table.Column<string>(type: "jsonb", nullable: false),
                    bucket_format = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    buckets = table.Column<byte[]>(type: "bytea", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_simulation_runs", x => x.id);
                    table.ForeignKey(
                        name: "fk_simulation_runs_scenario_entity_scenario_id",
                        column: x => x.scenario_id,
                        principalTable: "scenarios",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_scenarios_baseline_id_updated_at",
                table: "scenarios",
                columns: new[] { "baseline_id", "updated_at" });

            migrationBuilder.CreateIndex(
                name: "ix_scenarios_share_token",
                table: "scenarios",
                column: "share_token",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "ix_simulation_runs_scenario_id_created_at",
                table: "simulation_runs",
                columns: new[] { "scenario_id", "created_at" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "simulation_runs");

            migrationBuilder.DropTable(
                name: "scenarios");

            migrationBuilder.DropColumn(
                name: "osm_data",
                table: "network_baselines");
        }
    }
}
