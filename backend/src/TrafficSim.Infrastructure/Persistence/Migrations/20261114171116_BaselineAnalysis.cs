using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TrafficSim.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class BaselineAnalysis : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "analysis",
                table: "network_baselines",
                type: "jsonb",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "analysis",
                table: "network_baselines");
        }
    }
}
