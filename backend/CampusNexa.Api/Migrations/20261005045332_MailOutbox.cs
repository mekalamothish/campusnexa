using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CampusNexa.Api.Migrations
{
    /// <inheritdoc />
    public partial class MailOutbox : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "MailQueue",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    TenantId = table.Column<Guid>(type: "uuid", nullable: true),
                    InvitationId = table.Column<Guid>(type: "uuid", nullable: true),
                    UserId = table.Column<Guid>(type: "uuid", nullable: true),
                    Kind = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Payload = table.Column<string>(type: "text", nullable: false),
                    Status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Attempts = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    AvailableAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    CompletedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastError = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_MailQueue", x => x.Id);
                    table.CheckConstraint("CK_Mail_Scope", "(\"Kind\" = 'Invitation' AND \"TenantId\" IS NOT NULL AND \"InvitationId\" IS NOT NULL AND \"UserId\" IS NULL) OR (\"Kind\" = 'Recovery' AND \"TenantId\" IS NULL AND \"InvitationId\" IS NULL AND \"UserId\" IS NOT NULL)");
                    table.CheckConstraint("CK_Mail_Status", "\"Status\" IN ('Pending','Sent','Dead','Expired','Cancelled') AND \"Attempts\" BETWEEN 0 AND 5");
                    table.ForeignKey(
                        name: "FK_MailQueue_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_MailQueue_Invitations_TenantId_InvitationId",
                        columns: x => new { x.TenantId, x.InvitationId },
                        principalTable: "Invitations",
                        principalColumns: new[] { "TenantId", "Id" },
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_MailQueue_AvailableAt_Id",
                table: "MailQueue",
                columns: new[] { "AvailableAt", "Id" },
                filter: "\"Status\" = 'Pending'");

            migrationBuilder.CreateIndex(
                name: "IX_MailQueue_TenantId_InvitationId",
                table: "MailQueue",
                columns: new[] { "TenantId", "InvitationId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_MailQueue_UserId",
                table: "MailQueue",
                column: "UserId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "MailQueue");
        }
    }
}
