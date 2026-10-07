import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const base = "http://127.0.0.1:4200";
const alpha = "11111111-1111-1111-1111-111111111111";
const beta = "22222222-2222-2222-2222-222222222222";
if (process.env.ALLOW_FIXTURE_WRITES !== "1" || !process.env.ADMIN_PASSWORD)
  throw new Error(
    "Run only against the local fixture stack with .env and ALLOW_FIXTURE_WRITES=1.",
  );
const sqlArgs = [
  "compose",
  "exec",
  "-T",
  "db",
  "psql",
  "-U",
  "campusnexa",
  "-d",
  "campusnexa",
  "-v",
  "ON_ERROR_STOP=1",
  "-At",
];
const sql = (q) =>
  execFileSync("docker", [...sqlArgs, "-c", q], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  }).trim();
const url = (suffix, tenant = alpha) => `/api/tenants/${tenant}/${suffix}`;
class Client {
  cookies = new Map();
  async call(path, body, options = {}) {
    const headers = {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...options.headers,
    };
    if (options.csrf !== false && this.cookies.has("XSRF-TOKEN"))
      headers["X-XSRF-TOKEN"] = decodeURIComponent(
        this.cookies.get("XSRF-TOKEN"),
      );
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(base + path, {
      method: options.method ?? (body === undefined ? "GET" : "PUT"),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    for (const c of r.headers.getSetCookie()) {
      const pair = c.split(";")[0],
        i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const data = await r.json().catch(() => null);
    return { status: r.status, data };
  }
  async login(email) {
    await this.call("/api/auth/csrf");
    assert.equal(
      (
        await this.call(
          "/api/auth/login",
          { email, password: process.env.ADMIN_PASSWORD },
          { method: "POST" },
        )
      ).status,
      204,
    );
    await this.call("/api/auth/csrf");
  }
}
const overrides = (b) => ({
  timeZone: b.timeZoneOverride,
  locale: b.localeOverride,
  currency: b.currencyOverride,
  version: b.version,
});
const eventCount = (action, branch) =>
  Number(
    sql(
      `SELECT count(*) FROM "AuditEvents" WHERE "TenantId"='${alpha}' AND "Action"='${action}' AND ${branch ? `"BranchId"='${branch}'` : '"BranchId" IS NULL'}`,
    ),
  );

// Hold UPDATEs while allowing both HTTP handlers to read the same original row.
// This exercises EF's database concurrency predicate, not just the early HTTP comparison.
async function concurrentWrites(table, operation) {
  assert.ok(["Settings", "Branches"].includes(table));
  const child = spawn(
    "docker",
    [
      ...sqlArgs,
      "-c",
      `BEGIN; LOCK TABLE "${table}" IN SHARE MODE; SELECT 'SETTINGS_TEST_LOCKED'; SELECT pg_sleep(2); COMMIT;`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Test lock failed")),
    );
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out acquiring test write barrier")),
      10000,
    );
    child.stdout.on("data", (data) => {
      if (data.toString().includes("SETTINGS_TEST_LOCKED")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  try {
    return await operation();
  } finally {
    await done;
  }
}

test("Settings versions prevent lost updates and duplicate audit events", async (t) => {
  const admin = new Client(),
    second = new Client(),
    branch = new Client(),
    viewer = new Client(),
    other = new Client();
  await admin.login("admin@campusnexa.test");
  await second.login("admin@campusnexa.test");
  await branch.login("branch@campusnexa.test");
  await viewer.login("viewer@campusnexa.test");
  await other.login("other@campusnexa.test");
  const org = (await admin.call(url("settings"))).data;
  const foreign = (await other.call(url("settings", beta))).data;
  const branches = (await admin.call(url("branches"))).data;
  const main = branches.find((b) => b.code === "MAIN"),
    sibling = branches.find((b) => b.code === "NORTH");
  const branchUrl = url(`branches/${main.id}/settings`);
  try {
    await t.test(
      "nonempty versions are unique across tenants and branch records",
      async () => {
        for (const v of [
          org.version,
          foreign.version,
          main.version,
          sibling.version,
        ])
          assert.match(v, /^[0-9a-f-]{36}$/);
        assert.equal(
          new Set([org.version, foreign.version, main.version, sibling.version])
            .size,
          4,
        );
        const effective = (await admin.call(branchUrl)).data;
        assert.equal(effective.version, main.version);
        assert.equal(effective.defaultsVersion, org.version);
      },
    );
    await t.test(
      "missing, empty, invalid and foreign versions cannot write or audit",
      async () => {
        const before = eventCount("settings.updated"),
          beforeBranch = eventCount("branch.settings.updated", main.id);
        for (const version of [
          undefined,
          null,
          "00000000-0000-0000-0000-000000000000",
        ]) {
          assert.equal(
            (await admin.call(url("settings"), { ...org, version })).status,
            428,
          );
          assert.equal(
            (await branch.call(branchUrl, { ...overrides(main), version }))
              .status,
            428,
          );
        }
        assert.equal(
          (await admin.call(url("settings"), { ...org, version: "not-a-uuid" }))
            .status,
          400,
        );
        assert.equal(
          (
            await admin.call(url("settings"), {
              ...org,
              version: foreign.version,
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await branch.call(branchUrl, {
              ...overrides(main),
              version: sibling.version,
            })
          ).status,
          409,
        );
        assert.deepEqual((await admin.call(url("settings"))).data, org);
        assert.equal(eventCount("settings.updated"), before);
        assert.equal(
          eventCount("branch.settings.updated", main.id),
          beforeBranch,
        );
      },
    );
    await t.test(
      "authorization and CSRF still apply before version conflicts",
      async () => {
        assert.equal((await branch.call(url("settings"), org)).status, 403);
        assert.equal(
          (await viewer.call(branchUrl, overrides(main))).status,
          403,
        );
        assert.equal(
          (
            await branch.call(
              url(`branches/${sibling.id}/settings`),
              overrides(sibling),
            )
          ).status,
          404,
        );
        assert.equal((await other.call(url("settings"), org)).status, 404);
        assert.equal(
          (await admin.call(url("settings", beta), foreign)).status,
          404,
        );
        assert.equal(
          (await admin.call(url("settings"), org, { csrf: false })).status,
          400,
        );
        assert.equal(
          (
            await branch.call(url("settings"), org, {
              headers: { "X-Role": "OrganizationAdmin", "X-Tenant-ID": beta },
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "successful save rotates version; stale and replayed saves cannot overwrite",
      async () => {
        const before = eventCount("settings.updated");
        const saved = await admin.call(url("settings"), {
          ...org,
          academicYearLabel: "Concurrency fixture",
        });
        assert.equal(saved.status, 200);
        assert.notEqual(saved.data.version, org.version);
        const stale = await second.call(url("settings"), {
          ...org,
          academicYearLabel: "Must not win",
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.data.code, "settings_conflict");
        assert.equal((await second.call(url("settings"), org)).status, 409);
        assert.deepEqual((await admin.call(url("settings"))).data, saved.data);
        assert.equal(eventCount("settings.updated"), before + 1);
      },
    );
    await t.test(
      "simultaneous organization writes commit one value and one audit event",
      async () => {
        const current = (await admin.call(url("settings"))).data,
          before = eventCount("settings.updated");
        const results = await concurrentWrites("Settings", () =>
          Promise.all([
            admin.call(url("settings"), {
              ...current,
              academicYearLabel: "Concurrent A",
            }),
            second.call(url("settings"), {
              ...current,
              academicYearLabel: "Concurrent B",
            }),
          ]),
        );
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.deepEqual(
          (await admin.call(url("settings"))).data,
          results.find((r) => r.status === 200).data,
        );
        assert.equal(eventCount("settings.updated"), before + 1);
      },
    );
    await t.test(
      "branch writes use independent versions; default changes do not overwrite overrides",
      async () => {
        const current = (await admin.call(branchUrl)).data;
        const saved = await branch.call(branchUrl, {
          version: current.version,
          timeZone: "Asia/Kolkata",
          locale: "en-IN",
          currency: "INR",
        });
        assert.equal(saved.status, 200);
        assert.notEqual(saved.data.version, current.version);
        assert.equal(
          (
            await admin.call(branchUrl, {
              ...overrides(main),
              version: current.version,
            })
          ).status,
          409,
        );
        const defaults = (await admin.call(url("settings"))).data;
        assert.equal(
          (await admin.call(url("settings"), { ...defaults, currency: "EUR" }))
            .status,
          200,
        );
        const effective = (await branch.call(branchUrl)).data;
        assert.equal(effective.currency, "INR");
        assert.equal(effective.version, saved.data.version);
        const inherited = await branch.call(branchUrl, {
          version: effective.version,
          timeZone: null,
          locale: null,
          currency: null,
        });
        assert.equal(inherited.status, 200);
        assert.equal((await branch.call(branchUrl)).data.currency, "EUR");
      },
    );
    await t.test(
      "simultaneous branch writes commit one value and one audit event",
      async () => {
        const current = (await admin.call(branchUrl)).data,
          before = eventCount("branch.settings.updated", main.id);
        const results = await concurrentWrites("Branches", () =>
          Promise.all([
            admin.call(branchUrl, {
              version: current.version,
              timeZone: null,
              locale: null,
              currency: "USD",
            }),
            branch.call(branchUrl, {
              version: current.version,
              timeZone: null,
              locale: null,
              currency: "INR",
            }),
          ]),
        );
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          (await admin.call(branchUrl)).data.currency,
          results.find((r) => r.status === 200).data.currencyOverride,
        );
        assert.equal(
          eventCount("branch.settings.updated", main.id),
          before + 1,
        );
      },
    );
    await t.test(
      "validation and unknown versions preserve the saved row",
      async () => {
        const current = (await admin.call(url("settings"))).data,
          before = eventCount("settings.updated");
        assert.equal(
          (
            await admin.call(url("settings"), {
              ...current,
              timeZone: "Not/AZone",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await admin.call(url("settings"), {
              ...current,
              version: randomUUID(),
            })
          ).status,
          409,
        );
        assert.deepEqual((await admin.call(url("settings"))).data, current);
        assert.equal(eventCount("settings.updated"), before);
        assert.deepEqual(
          (await other.call(url("settings", beta))).data,
          foreign,
        );
      },
    );
    await t.test(
      "an unchanged save still consumes its version once",
      async () => {
        const current = (await admin.call(url("settings"))).data,
          before = eventCount("settings.updated");
        const result = await admin.call(url("settings"), current);
        assert.equal(result.status, 200);
        assert.notEqual(result.data.version, current.version);
        assert.equal((await second.call(url("settings"), current)).status, 409);
        assert.equal(eventCount("settings.updated"), before + 1);
      },
    );
  } finally {
    const latest = (await admin.call(url("settings"))).data;
    assert.equal(
      (await admin.call(url("settings"), { ...org, version: latest.version }))
        .status,
      200,
    );
    const latestBranch = (await admin.call(branchUrl)).data;
    assert.equal(
      (
        await branch.call(branchUrl, {
          ...overrides(main),
          version: latestBranch.version,
        })
      ).status,
      200,
    );
  }
});
