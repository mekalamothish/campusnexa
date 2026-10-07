using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CampusNexa.Api.Migrations
{
    /// <inheritdoc />
    public partial class SettingsConcurrencyAndAuditGuards : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                CREATE FUNCTION campusnexa_audit_events_append_only() RETURNS trigger
                LANGUAGE plpgsql AS $$ BEGIN
                    RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE = '55000';
                END $$;
                CREATE TRIGGER audit_events_no_update_delete BEFORE UPDATE OR DELETE ON "AuditEvents"
                FOR EACH ROW EXECUTE FUNCTION campusnexa_audit_events_append_only();
                CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON "AuditEvents"
                FOR EACH STATEMENT EXECUTE FUNCTION campusnexa_audit_events_append_only();
                """);
            migrationBuilder.AddColumn<Guid>(
                name: "Version",
                table: "Settings",
                type: "uuid",
                nullable: false,
                defaultValueSql: "gen_random_uuid()");

            migrationBuilder.AddColumn<Guid>(
                name: "Version",
                table: "Branches",
                type: "uuid",
                nullable: false,
                defaultValueSql: "gen_random_uuid()");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                DROP TRIGGER audit_events_no_update_delete ON "AuditEvents";
                DROP TRIGGER audit_events_no_truncate ON "AuditEvents";
                DROP FUNCTION campusnexa_audit_events_append_only();
                """);
            migrationBuilder.DropColumn(
                name: "Version",
                table: "Settings");

            migrationBuilder.DropColumn(
                name: "Version",
                table: "Branches");
        }
    }
}
