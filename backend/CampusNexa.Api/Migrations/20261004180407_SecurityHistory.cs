using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CampusNexa.Api.Migrations
{
    /// <inheritdoc />
    public partial class SecurityHistory : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "SecurityEvents",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    Action = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    OccurredAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SecurityEvents", x => x.Id);
                    table.CheckConstraint("CK_SecurityEvent_Action", "\"Action\" IN ('PasswordSignIn','SignInFailed','MfaChallengeStarted','MfaSignIn','RecoveryCodeSignIn','MfaVerificationFailed','MfaSetupStarted','MfaEnabled','MfaDisabled','RecoveryCodesReplaced','MfaManagementFailed','PasswordRecoveryRequested','RecoveryDeliveryFailed','PasswordReset','PasswordResetFailed','SignedOut','SessionsRevoked','AuthenticatorKeyProtected')");
                    table.ForeignKey(
                        name: "FK_SecurityEvents_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_SecurityEvents_UserId_OccurredAt_Id",
                table: "SecurityEvents",
                columns: new[] { "UserId", "OccurredAt", "Id" });

            migrationBuilder.Sql("""
                CREATE FUNCTION campusnexa_security_events_append_only() RETURNS trigger
                LANGUAGE plpgsql AS $$ BEGIN
                    RAISE EXCEPTION 'Security events are append-only' USING ERRCODE = '55000';
                END $$;
                CREATE TRIGGER security_events_no_update_delete BEFORE UPDATE OR DELETE ON "SecurityEvents"
                FOR EACH ROW EXECUTE FUNCTION campusnexa_security_events_append_only();
                CREATE TRIGGER security_events_no_truncate BEFORE TRUNCATE ON "SecurityEvents"
                FOR EACH STATEMENT EXECUTE FUNCTION campusnexa_security_events_append_only();
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "SecurityEvents");
            migrationBuilder.Sql("DROP FUNCTION campusnexa_security_events_append_only();");
        }
    }
}
