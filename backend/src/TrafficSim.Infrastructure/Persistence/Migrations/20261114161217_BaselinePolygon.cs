using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TrafficSim.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class BaselinePolygon : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "polygon_ring",
                table: "network_baselines",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "polygon_ring",
                table: "network_baselines");
        }
    }
}
