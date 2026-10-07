using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CampusNexa.Api.Migrations
{
    /// <inheritdoc />
    public partial class HistoryPagination : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_AuditEvents_TenantId_BranchId",
                table: "AuditEvents");

            migrationBuilder.CreateIndex(
                name: "IX_Invitations_TenantId_CreatedAt_Id",
                table: "Invitations",
                columns: new[] { "TenantId", "CreatedAt", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_AuditEvents_TenantId_BranchId_OccurredAt_Id",
                table: "AuditEvents",
                columns: new[] { "TenantId", "BranchId", "OccurredAt", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_AuditEvents_TenantId_OccurredAt_Id",
                table: "AuditEvents",
                columns: new[] { "TenantId", "OccurredAt", "Id" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Invitations_TenantId_CreatedAt_Id",
                table: "Invitations");

            migrationBuilder.DropIndex(
                name: "IX_AuditEvents_TenantId_BranchId_OccurredAt_Id",
                table: "AuditEvents");

            migrationBuilder.DropIndex(
                name: "IX_AuditEvents_TenantId_OccurredAt_Id",
                table: "AuditEvents");

            migrationBuilder.CreateIndex(
                name: "IX_AuditEvents_TenantId_BranchId",
                table: "AuditEvents",
                columns: new[] { "TenantId", "BranchId" });
        }
    }
}
