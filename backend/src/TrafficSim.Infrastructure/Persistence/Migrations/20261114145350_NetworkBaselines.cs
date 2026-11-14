using System;
using System.Collections.Generic;
using Microsoft.EntityFrameworkCore.Migrations;
using NetTopologySuite.Geometries;

#nullable disable

namespace TrafficSim.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class NetworkBaselines : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "network_baselines",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    area = table.Column<Polygon>(type: "geometry(Polygon,4326)", nullable: false),
                    south = table.Column<double>(type: "double precision", nullable: false),
                    west = table.Column<double>(type: "double precision", nullable: false),
                    north = table.Column<double>(type: "double precision", nullable: false),
                    east = table.Column<double>(type: "double precision", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    source = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    osm_timestamp = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    nodes = table.Column<int>(type: "integer", nullable: false),
                    links = table.Column<int>(type: "integer", nullable: false),
                    lanes = table.Column<int>(type: "integer", nullable: false),
                    connectors = table.Column<int>(type: "integer", nullable: false),
                    signals = table.Column<int>(type: "integer", nullable: false),
                    attribution = table.Column<List<string>>(type: "text[]", nullable: false),
                    package = table.Column<byte[]>(type: "bytea", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_network_baselines", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "ix_network_baselines_area",
                table: "network_baselines",
                column: "area")
                .Annotation("Npgsql:IndexMethod", "gist");

            migrationBuilder.CreateIndex(
                name: "ix_network_baselines_created_at",
                table: "network_baselines",
                column: "created_at");

            migrationBuilder.CreateIndex(
                name: "ix_network_baselines_south_west_north_east",
                table: "network_baselines",
                columns: new[] { "south", "west", "north", "east" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "network_baselines");
        }
    }
}
