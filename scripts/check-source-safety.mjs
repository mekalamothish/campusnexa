// Checks the staged snapshot, not just filenames in the working directory.
// This is a publication guard, not a comprehensive secret scanner.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const git = (args) =>
  execFileSync("git", args, { cwd: root, maxBuffer: 20 * 1024 * 1024 });
const files = git(["ls-files", "-z"]).toString().split("\0").filter(Boolean);
if (!files.length) throw new Error("No tracked source snapshot to check.");
const secrets = [];
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (
      ["POSTGRES_PASSWORD", "ADMIN_PASSWORD"].includes(line.slice(0, index))
    ) {
      const value = line.slice(index + 1).trim();
      if (value.length >= 12) secrets.push(value);
    }
  }
}
const failures = [];
for (const file of files) {
  const segments = file.split("/");
  if (
    segments.some((s) =>
      [
        ".runtime",
        "backups",
        "node_modules",
        "bin",
        "obj",
        "dist",
        "out-tsc",
        ".angular",
        "test-results",
        "playwright-report",
      ].includes(s),
    ) ||
    segments.some(
      (s) => (s === ".env" || s.startsWith(".env.")) && s !== ".env.example",
    ) ||
    /\.(dump|pfx|p12|pem|key|tar|zip)$/i.test(file)
  ) {
    failures.push(file + ": private/generated path");
    continue;
  }
  const data = git(["show", ":" + file]).toString("utf8");
  if (secrets.some((secret) => data.includes(secret)))
    failures.push(file + ": contains a local credential");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(data) ||
    /\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(data) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(data)
  )
    failures.push(file + ": possible private key or access credential");
}
if (failures.length)
  throw new Error("Source publication refused:\n" + failures.join("\n"));
console.log(
  `Source publication checks passed for ${files.length} tracked files. No local passwords, private runtime paths, or detected key/token material found.`,
);
