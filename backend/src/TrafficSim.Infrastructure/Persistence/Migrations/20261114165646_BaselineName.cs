using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TrafficSim.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class BaselineName : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "name",
                table: "network_baselines",
                type: "character varying(120)",
                maxLength: 120,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "name",
                table: "network_baselines");
        }
    }
}
