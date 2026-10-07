import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const base = "http://127.0.0.1:4200",
  alpha = "11111111-1111-1111-1111-111111111111",
  beta = "22222222-2222-2222-2222-222222222222";
if (process.env.ALLOW_FIXTURE_WRITES !== "1" || !process.env.ADMIN_PASSWORD)
  throw new Error("Use only the local fixture environment.");
const sql = (q) =>
  execFileSync(
    "docker",
    [
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
      "-Atc",
      q,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
  ).trim();
class Client {
  cookies = new Map();
  async call(path, body, extra = {}) {
    const headers = {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...extra,
    };
    if (this.cookies.has("XSRF-TOKEN"))
      headers["X-XSRF-TOKEN"] = decodeURIComponent(
        this.cookies.get("XSRF-TOKEN"),
      );
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(base + path, {
      signal: AbortSignal.timeout(15000),
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of r.headers.getSetCookie()) {
      const p = c.split(";")[0],
        i = p.indexOf("=");
      this.cookies.set(p.slice(0, i), p.slice(i + 1));
    }
    let data;
    try {
      data = await r.json();
    } catch {}
    return { status: r.status, data };
  }
  async login(email) {
    await this.call("/api/auth/csrf");
    assert.equal(
      (
        await this.call("/api/auth/login", {
          email,
          password: process.env.ADMIN_PASSWORD,
        })
      ).status,
      204,
    );
    await this.call("/api/auth/csrf");
  }
}
const url = (kind, tenant = alpha, query = "") =>
  `/api/tenants/${tenant}/${kind}${query ? "?" + query : ""}`;
const query = (size, cursor) =>
  `pageSize=${size}` + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");

test("Scoped keyset history pagination", async (t) => {
  const admin = new Client(),
    branch = new Client(),
    viewer = new Client(),
    other = new Client(),
    guest = new Client();
  await admin.login("admin@campusnexa.test");
  await branch.login("branch@campusnexa.test");
  await viewer.login("viewer@campusnexa.test");
  await other.login("other@campusnexa.test");
  const suffix = randomUUID().replaceAll("-", ""),
    main = (await admin.call(`/api/tenants/${alpha}/branches`)).data.find(
      (b) => b.code === "MAIN",
    ).id;
  const foreignBranch = (
    await other.call(`/api/tenants/${beta}/branches`)
  ).data.find((b) => b.code === "MAIN").id;
  const sibling = await admin.call(`/api/tenants/${alpha}/branches`, {
    name: "Pagination fixture " + suffix.slice(0, 8),
    code: "PG" + suffix.slice(0, 9),
  });
  assert.equal(sibling.status, 201);
  // Historical, revoked fictional invitations only: no mail jobs, real recipients or active links.
  for (const [tenant, branchId, count] of [
    [alpha, main, 192],
    [beta, foreignBranch, 31],
  ]) {
    sql(`INSERT INTO "Invitations" ("TenantId","Id","Email","NormalizedEmail","Role","BranchId","TokenHash","CreatedAt","ExpiresAt","RevokedAt")
   SELECT '${tenant}', id, 'history-${suffix}-'||n||'@campusnexa.test', upper('history-${suffix}-'||n||'@campusnexa.test'), 'Viewer','${branchId}',upper(md5(id::text)||md5(id::text)), '2001-01-01T00:00:00.123456Z','2001-01-03T00:00:00.123456Z',now()
   FROM (SELECT gen_random_uuid() id,n FROM generate_series(1,${count}) n) s;`);
    sql(`INSERT INTO "AuditEvents" ("TenantId","Id","ActorId","BranchId","Action","Subject","OccurredAt")
   SELECT '${tenant}',gen_random_uuid(),'00000000-0000-0000-0000-000000000000',
    CASE WHEN n%3=0 THEN NULL ELSE '${branchId}'::uuid END,'pagination.fixture','history-${suffix}-'||n,'2001-01-01T00:00:00.123456Z' FROM generate_series(1,${count}) n;`);
  }
  sql(
    `INSERT INTO "AuditEvents" ("TenantId","Id","ActorId","BranchId","Action","Subject","OccurredAt") VALUES ('${alpha}','${randomUUID()}','00000000-0000-0000-0000-000000000000','${sibling.data.id}','pagination.fixture','sibling-${suffix}','2001-01-01T00:00:00.123456Z');`,
  );
  const pages = {};
  async function first(kind, client = admin, tenant = alpha, size = 17) {
    const r = await client.call(url(kind, tenant, query(size)));
    assert.equal(r.status, 200);
    return r.data;
  }
  async function walk(kind, client, tenant, branchId = null) {
    let page = await first(kind, client, tenant),
      ids = [],
      seen = new Set(),
      round = 0;
    const snapshot = page.snapshotAt;
    while (true) {
      assert.ok(++round < 500, "bounded traversal");
      assert.ok(page.items.length <= 17);
      assert.equal(page.pageSize, 17);
      assert.equal(page.snapshotAt, snapshot);
      for (const row of page.items) {
        assert.ok(!seen.has(row.id), "no duplicate IDs");
        seen.add(row.id);
        ids.push(row.id);
        if (branchId) assert.equal(row.branchId, branchId);
      }
      if (!page.nextCursor) break;
      assert.ok(page.items.length === 17);
      const next = await client.call(
        url(kind, tenant, query(17, page.nextCursor)),
      );
      assert.equal(next.status, 200);
      page = next.data;
    }
    const table = kind === "audit" ? "AuditEvents" : "Invitations",
      stamp = kind === "audit" ? "OccurredAt" : "CreatedAt";
    const expected = sql(
      `SELECT "Id" FROM "${table}" WHERE "TenantId"='${tenant}' AND "${stamp}"<='${snapshot}' ${branchId ? `AND "BranchId"='${branchId}'` : ""} ORDER BY "${stamp}" DESC,"Id" DESC`,
    )
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(ids, expected);
    assert.ok(ids.length > 100);
    return ids;
  }
  await t.test(
    "default and bounded page sizes return an explicit cursor envelope",
    async () => {
      for (const kind of ["invitations", "audit"]) {
        const r = await admin.call(url(kind));
        assert.equal(r.status, 200);
        assert.equal(r.data.items.length, 25);
        assert.equal(r.data.pageSize, 25);
        assert.deepEqual(Object.keys(r.data).sort(), [
          "items",
          "nextCursor",
          "pageSize",
          "snapshotAt",
          "startCursor",
        ]);
        pages[kind] = await first(kind);
        assert.ok(pages[kind].nextCursor);
        assert.ok(pages[kind].startCursor);
        assert.equal((await first(kind, admin, alpha, 100)).items.length, 100);
        for (const bad of [
          "pageSize=0",
          "pageSize=101",
          "pageSize=-1",
          "pageSize=1.5",
          "pageSize=bad",
          "pageSize=",
          "pageSize=1&pageSize=2",
          "cursor=",
          "cursor=invalid",
          "cursor=one&cursor=two",
          "cursor=" + "x".repeat(2049),
        ])
          assert.equal(
            (await admin.call(url(kind, alpha, bad))).status,
            400,
            bad.slice(0, 60),
          );
      }
    },
  );
  await t.test(
    "all records beyond the former 100 cap traverse in exact database order, including timestamp ties",
    async () => {
      await walk("invitations", admin, alpha);
      await walk("audit", admin, alpha);
    },
  );
  await t.test(
    "branch and viewer pages never reveal sibling or organization-wide audit",
    async () => {
      await walk("audit", branch, alpha, main);
      await walk("audit", viewer, alpha, main);
      assert.equal((await branch.call(url("invitations"))).status, 403);
      assert.equal((await viewer.call(url("invitations"))).status, 403);
    },
  );
  await t.test(
    "cursors reject tampering, another resource, user, tenant, size or changed branch grant",
    async () => {
      for (const kind of ["invitations", "audit"]) {
        const cursor = pages[kind].nextCursor;
        assert.equal(
          (await guest.call(url(kind, alpha, query(17, cursor)))).status,
          401,
        );
        assert.equal(
          (await other.call(url(kind, alpha, query(17, cursor)))).status,
          404,
        );
        assert.equal(
          (await other.call(url(kind, beta, query(17, cursor)))).status,
          400,
        );
        assert.equal(
          (await admin.call(url(kind, alpha, query(18, cursor)))).status,
          400,
        );
        assert.equal(
          (
            await admin.call(
              url(kind, alpha, query(17, cursor.slice(0, -20) + "tampered")),
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await admin.call(
              url(
                kind === "audit" ? "invitations" : "audit",
                alpha,
                query(17, cursor),
              ),
            )
          ).status,
          400,
        );
      }
      assert.equal(
        (
          await branch.call(
            url("audit", alpha, query(17, pages.audit.nextCursor)),
            undefined,
            { "X-Role": "OrganizationAdmin", "X-Tenant-ID": beta },
          )
        ).status,
        400,
      );
      const own = await first("audit", branch),
        branchUser = (await branch.call("/api/auth/me")).data.id;
      sql(
        `UPDATE "Memberships" SET "BranchId"='${sibling.data.id}' WHERE "TenantId"='${alpha}' AND "UserId"='${branchUser}'`,
      );
      try {
        assert.equal(
          (await branch.call(url("audit", alpha, query(17, own.nextCursor))))
            .status,
          400,
        );
      } finally {
        sql(
          `UPDATE "Memberships" SET "BranchId"='${main}' WHERE "TenantId"='${alpha}' AND "UserId"='${branchUser}'`,
        );
      }
      assert.equal(
        (await branch.call(url("audit", alpha, query(17, own.nextCursor))))
          .status,
        200,
      );
    },
  );
  await t.test(
    "new inserts do not shift an existing traversal; start cursor and refresh have distinct behavior",
    async () => {
      const beforeInv = await first("invitations"),
        beforeAudit = await first("audit");
      const fresh = await admin.call(url("invitations"), {
        email: `latest-${suffix}@campusnexa.test`,
        role: "Viewer",
        branchId: main,
      });
      assert.equal(fresh.status, 201);
      for (const [kind, page] of [
        ["invitations", beforeInv],
        ["audit", beforeAudit],
      ]) {
        const restarted = (
          await admin.call(url(kind, alpha, query(17, page.startCursor)))
        ).data;
        assert.equal(restarted.snapshotAt, page.snapshotAt);
        assert.deepEqual(
          restarted.items.map((r) => r.id),
          page.items.map((r) => r.id),
        );
        const latest = await first(kind);
        assert.notDeepEqual(
          latest.items.map((r) => r.id),
          page.items.map((r) => r.id),
        );
      }
      assert.equal((await first("invitations")).items[0].id, fresh.data.id);
      const repeated = (
        await admin.call(
          url("invitations", alpha, query(17, beforeInv.nextCursor)),
        )
      ).data;
      assert.ok(!repeated.items.some((r) => r.id === fresh.data.id));
    },
  );
  await t.test(
    "permission gates are re-evaluated after a cursor was issued",
    async () => {
      const id = (await admin.call("/api/auth/me")).data.id;
      for (const [disable, restore, status] of [
        [
          `UPDATE "Memberships" SET "IsActive"=false WHERE "TenantId"='${alpha}' AND "UserId"='${id}'`,
          `UPDATE "Memberships" SET "IsActive"=true WHERE "TenantId"='${alpha}' AND "UserId"='${id}'`,
          404,
        ],
        [
          `UPDATE "Entitlements" SET "Enabled"=false WHERE "TenantId"='${alpha}' AND "Module"='platform'`,
          `UPDATE "Entitlements" SET "Enabled"=true WHERE "TenantId"='${alpha}' AND "Module"='platform'`,
          403,
        ],
      ]) {
        sql(disable);
        try {
          for (const kind of ["invitations", "audit"])
            assert.equal(
              (
                await admin.call(
                  url(kind, alpha, query(17, pages[kind].nextCursor)),
                )
              ).status,
              status,
            );
        } finally {
          sql(restore);
        }
      }
    },
  );
  await t.test(
    "an empty branch scope returns an empty page with no next cursor",
    async () => {
      // A transaction-local empty tenant isn't reachable over HTTP; instead issue a
      // narrow branch grant with no audit events by temporarily using a fresh branch.
      const emptyId = randomUUID(),
        branchUser = (await branch.call("/api/auth/me")).data.id;
      sql(
        `INSERT INTO "Branches" ("TenantId","Id","Name","Code","CreatedAt") VALUES ('${alpha}','${emptyId}','Empty pagination fixture','E${suffix.slice(0, 10)}',now()); UPDATE "Memberships" SET "BranchId"='${emptyId}' WHERE "TenantId"='${alpha}' AND "UserId"='${branchUser}';`,
      );
      try {
        const page = await first("audit", branch);
        assert.deepEqual(page.items, []);
        assert.equal(page.nextCursor, null);
        assert.ok(page.startCursor);
      } finally {
        sql(
          `UPDATE "Memberships" SET "BranchId"='${main}' WHERE "TenantId"='${alpha}' AND "UserId"='${branchUser}'`,
        );
      }
    },
  );
});
