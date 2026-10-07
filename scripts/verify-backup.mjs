import { spawn, execFileSync } from "node:child_process";
import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, relative, sep } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.argv[2])
  throw new Error("Usage: node scripts/verify-backup.mjs backups/<file>.dump");
const path = realpathSync(resolve(root, process.argv[2]));
const inside = relative(realpathSync(resolve(root, "backups")), path);
if (
  inside.startsWith(".." + sep) ||
  inside === ".." ||
  !inside.endsWith(".dump")
)
  throw new Error(
    "Choose a .dump file inside this project’s backups directory.",
  );
const metadata = JSON.parse(readFileSync(path + ".json", "utf8"));
const hash = createHash("sha256");
for await (const chunk of createReadStream(path)) hash.update(chunk);
if (
  metadata.formatVersion !== 1 ||
  metadata.database !== "campusnexa" ||
  hash.digest("hex") !== metadata.sha256
)
  throw new Error("Backup manifest/hash does not match. Nothing restored.");
const database = "campusnexa_verify_" + randomBytes(8).toString("hex");
const docker = (args) =>
  execFileSync("docker", ["compose", "exec", "-T", "db", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
docker(["createdb", "-U", "campusnexa", database]);
console.log(
  `Created isolated restore target: ${database}. The primary campusnexa database is unchanged.`,
);
const child = spawn(
  "docker",
  [
    "compose",
    "exec",
    "-T",
    "db",
    "pg_restore",
    "-U",
    "campusnexa",
    "-d",
    database,
    "--no-owner",
    "--no-acl",
    "--exit-on-error",
  ],
  { cwd: root, stdio: ["pipe", "inherit", "inherit"] },
);
const done = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0
      ? resolve()
      : reject(
          new Error(
            `Restore failed with exit ${code}; isolated target ${database} retained for diagnosis.`,
          ),
        ),
  );
});
await Promise.all([pipeline(createReadStream(path), child.stdin), done]);
const counts = {};
for (const table of [
  "Organizations",
  "Branches",
  "Memberships",
  "AspNetUsers",
  "Settings",
  "Entitlements",
  "AuditEvents",
  "__EFMigrationsHistory",
]) {
  counts[table] = Number(
    docker([
      "psql",
      "-U",
      "campusnexa",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      `SELECT count(*) FROM "${table}";`,
    ]).trim(),
  );
}
if (counts["__EFMigrationsHistory"] < 1)
  throw new Error("Restored migration history is empty.");
// Older milestone backups legitimately predate these additive tables.
for (const table of ["Invitations", "SecurityEvents", "MailQueue"]) {
  const exists =
    docker([
      "psql",
      "-U",
      "campusnexa",
      "-d",
      database,
      "-Atc",
      `SELECT to_regclass('public."${table}"') IS NOT NULL;`,
    ]).trim() === "t";
  if (exists)
    counts[table] = Number(
      docker([
        "psql",
        "-U",
        "campusnexa",
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
        "-Atc",
        `SELECT count(*) FROM "${table}";`,
      ]).trim(),
    );
}
let securityTriggers = null;
if (Object.hasOwn(counts, "SecurityEvents")) {
  securityTriggers = Number(
    docker([
      "psql",
      "-U",
      "campusnexa",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      `SELECT count(*) FROM pg_trigger WHERE tgrelid='public."SecurityEvents"'::regclass AND tgname IN ('security_events_no_update_delete','security_events_no_truncate') AND tgenabled='O';`,
    ]).trim(),
  );
  if (securityTriggers !== 2)
    throw new Error(
      "Restored security-history guards are missing or disabled.",
    );
}
// Only require guards introduced by a migration if that migration is in this backup.
const hasSettingsGuards =
  docker([
    "psql",
    "-U",
    "campusnexa",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-Atc",
    `SELECT EXISTS(SELECT 1 FROM "__EFMigrationsHistory" WHERE "MigrationId"='20261006041606_SettingsConcurrencyAndAuditGuards');`,
  ]).trim() === "t";
let auditTriggers = null;
if (hasSettingsGuards) {
  auditTriggers = Number(
    docker([
      "psql",
      "-U",
      "campusnexa",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      `SELECT count(*) FROM pg_trigger WHERE tgrelid='public."AuditEvents"'::regclass AND tgname IN ('audit_events_no_update_delete','audit_events_no_truncate') AND tgenabled='O';`,
    ]).trim(),
  );
  if (auditTriggers !== 2)
    throw new Error("Restored audit guards are missing or disabled.");
  const missingVersions = Number(
    docker([
      "psql",
      "-U",
      "campusnexa",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      `SELECT (SELECT count(*) FROM "Settings" WHERE "Version" IS NULL OR "Version"='00000000-0000-0000-0000-000000000000') + (SELECT count(*) FROM "Branches" WHERE "Version" IS NULL OR "Version"='00000000-0000-0000-0000-000000000000');`,
    ]).trim(),
  );
  if (missingVersions !== 0)
    throw new Error("Restored settings versions are missing.");
}
console.log(
  JSON.stringify(
    {
      status: "restored-and-schema-checked",
      database,
      rowCounts: counts,
      securityTriggers,
      auditTriggers,
    },
    null,
    2,
  ),
);
console.log(
  "Verification database retained for inspection. No database was deleted.",
);
