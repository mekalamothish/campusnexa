import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { waitForMail } from "./mail-helper.mjs";

const base = "http://127.0.0.1:4200",
  inbox = "http://127.0.0.1:8025";
const alpha = "11111111-1111-1111-1111-111111111111";
const beta = "22222222-2222-2222-2222-222222222222";
if (process.env.ALLOW_FIXTURE_WRITES !== "1" || !process.env.ADMIN_PASSWORD)
  throw new Error("Use the local fixture environment.");
const docker = (args) =>
  execFileSync("docker", ["compose", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const sql = (q) =>
  docker([
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
  ]).trim();
const path = (tenant = alpha) => `/api/tenants/${tenant}/invitations`;
class Client {
  cookies = new Map();
  async call(url, body, extra = {}, csrf = true) {
    const headers = {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...extra,
    };
    if (csrf && this.cookies.has("XSRF-TOKEN"))
      headers["X-XSRF-TOKEN"] = decodeURIComponent(
        this.cookies.get("XSRF-TOKEN"),
      );
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(base + url, {
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
  async csrf() {
    assert.equal((await this.call("/api/auth/csrf")).status, 204);
  }
  async login(email) {
    await this.csrf();
    assert.equal(
      (
        await this.call("/api/auth/login", {
          email,
          password: process.env.ADMIN_PASSWORD,
        })
      ).status,
      204,
    );
    await this.csrf();
  }
}

test("Tenant-scoped invitation delivery and replacement", async (t) => {
  const admin = new Client(),
    other = new Client(),
    branchAdmin = new Client(),
    viewer = new Client(),
    guest = new Client();
  await admin.login("admin@campusnexa.test");
  await other.login("other@campusnexa.test");
  await branchAdmin.login("branch@campusnexa.test");
  await viewer.login("viewer@campusnexa.test");
  await guest.csrf();
  const adminId = (await admin.call("/api/auth/me")).data.id;
  const branch = (await admin.call(`/api/tenants/${alpha}/branches`)).data.find(
    (b) => b.code === "MAIN",
  ).id;
  const suffix = Date.now().toString(36);
  let seq = 0;
  const create = async (client = admin, tenant = alpha, role = "Viewer") => {
    const r = await client.call(path(tenant), {
      email: `delivery-${suffix}-${seq++}@campusnexa.test`,
      role,
      branchId: role === "OrganizationAdmin" ? null : branch,
    });
    assert.equal(r.status, 201);
    return r.data;
  };
  const row = (id) =>
    JSON.parse(
      sql(`SELECT row_to_json(i) FROM "Invitations" i WHERE "Id"='${id}'`),
    );
  const job = (id) =>
    JSON.parse(
      sql(
        `SELECT row_to_json(m) FROM "MailQueue" m WHERE "InvitationId"='${id}'`,
      ),
    );
  // Only freshly created fixtures are manipulated. Actual SMTP failure/exhaustion is
  // covered by outbox.integration; here terminal states are deterministic preconditions.
  const dead = (id) =>
    sql(
      `UPDATE "MailQueue" SET "Status"='Dead', "Attempts"=5, "Payload"='', "LastError"='DeliveryFailed', "CompletedAt"=now() WHERE "InvitationId"='${id}'`,
    );
  const retry = (id, client = admin, tenant = alpha, body = {}) =>
    client.call(`${path(tenant)}/${id}/retry-delivery`, body);
  const listed = async (id) => {
    const r = await admin.call(path());
    assert.equal(r.status, 200);
    return r.data.items.find((i) => i.id === id);
  };
  docker(["stop", "worker"]);
  t.after(() => docker(["up", "-d", "--no-deps", "worker"]));
  const candidate = await create();
  dead(candidate.id);
  const foreign = await create(other, beta, "OrganizationAdmin");
  dead(foreign.id);

  await t.test(
    "safe metadata is tenant-scoped, redacted and absent on legacy invitations",
    async () => {
      const pending = await create();
      const data = (await listed(pending.id)).delivery;
      assert.deepEqual(Object.keys(data).sort(), [
        "attempts",
        "completedAt",
        "nextAttemptAt",
        "status",
      ]);
      assert.equal(data.status, "Pending");
      assert.equal(data.attempts, 0);
      assert.ok(data.nextAttemptAt);
      assert.equal(data.completedAt, null);
      const own = await listed(candidate.id);
      assert.equal(own.delivery.status, "Dead");
      assert.equal(own.delivery.nextAttemptAt, null);
      const list = (await admin.call(path())).data.items;
      assert.ok(!list.some((i) => i.id === foreign.id));
      const otherList = (await other.call(path(beta))).data.items;
      assert.ok(
        otherList.some(
          (i) => i.id === foreign.id && i.delivery.status === "Dead",
        ),
      );
      assert.ok(!otherList.some((i) => i.id === candidate.id));
      assert.ok(!JSON.stringify(list).includes(job(pending.id).Payload));
      assert.ok(!JSON.stringify(list).includes(row(pending.id).TokenHash));
      assert.ok(!JSON.stringify(list).includes("lastError"));
      // Emulate an invitation from before MailQueue existed, in this fixture only.
      sql(`DELETE FROM "MailQueue" WHERE "InvitationId"='${pending.id}'`);
      assert.equal((await listed(pending.id)).delivery, null);
      assert.equal((await retry(pending.id)).status, 409);
      assert.equal((await admin.call("/api/mail-queue")).status, 404);
    },
  );
  await t.test(
    "anonymous, branch, viewer, cross-school and forged-scope requests are denied",
    async () => {
      assert.equal((await guest.call(path())).status, 401);
      assert.equal((await retry(candidate.id, guest)).status, 401);
      for (const client of [branchAdmin, viewer]) {
        assert.equal(
          (
            await client.call(path(), undefined, {
              "X-Role": "OrganizationAdmin",
              "X-Tenant-ID": alpha,
            })
          ).status,
          403,
        );
        assert.equal((await retry(candidate.id, client)).status, 403);
      }
      assert.equal((await other.call(path())).status, 404);
      assert.equal((await retry(candidate.id, other)).status, 404);
      assert.equal((await retry(foreign.id)).status, 404);
      assert.equal((await retry(candidate.id, other, beta)).status, 404);
      assert.equal(
        (
          await admin.call(
            `${path()}/${candidate.id}/retry-delivery`,
            {},
            {},
            false,
          )
        ).status,
        400,
      );
      assert.equal(row(candidate.id).RevokedAt, null);
    },
  );
  await t.test(
    "inactive organization, disabled platform and inactive membership fail closed",
    async () => {
      for (const [disable, restore, status] of [
        [
          `UPDATE "Organizations" SET "IsActive"=false WHERE "Id"='${alpha}'`,
          `UPDATE "Organizations" SET "IsActive"=true WHERE "Id"='${alpha}'`,
          404,
        ],
        [
          `UPDATE "Entitlements" SET "Enabled"=false WHERE "TenantId"='${alpha}' AND "Module"='platform'`,
          `UPDATE "Entitlements" SET "Enabled"=true WHERE "TenantId"='${alpha}' AND "Module"='platform'`,
          403,
        ],
        [
          `UPDATE "Memberships" SET "IsActive"=false WHERE "TenantId"='${alpha}' AND "UserId"='${adminId}'`,
          `UPDATE "Memberships" SET "IsActive"=true WHERE "TenantId"='${alpha}' AND "UserId"='${adminId}'`,
          404,
        ],
      ]) {
        sql(disable);
        try {
          assert.equal((await admin.call(path())).status, status);
          assert.equal((await retry(candidate.id)).status, status);
        } finally {
          sql(restore);
        }
      }
    },
  );
  await t.test(
    "pending, sent, cancelled, expired, accepted and revoked invitations cannot retry",
    async () => {
      for (const status of ["Pending", "Sent", "Cancelled", "Expired"]) {
        const i = await create();
        if (status !== "Pending")
          sql(
            `UPDATE "MailQueue" SET "Status"='${status}', "Payload"='', "CompletedAt"=now() WHERE "InvitationId"='${i.id}'`,
          );
        assert.equal((await retry(i.id)).status, 409);
        assert.equal(row(i.id).RevokedAt, null);
      }
      for (const column of ["ExpiresAt", "AcceptedAt", "RevokedAt"]) {
        const i = await create();
        dead(i.id);
        sql(
          `UPDATE "Invitations" SET "${column}"=now()-interval '1 second' WHERE "Id"='${i.id}'`,
        );
        assert.equal((await retry(i.id)).status, 409);
      }
    },
  );
  await t.test(
    "queue-insert failure rolls back revocation, replacement and linked audit",
    async () => {
      const i = await create();
      dead(i.id);
      const trigger = `delivery_fault_${suffix}`;
      sql(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."InvitationId" IN (SELECT "Id" FROM "Invitations" WHERE "Email"='${i.email}')
      THEN RAISE EXCEPTION 'injected delivery queue fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${trigger} BEFORE INSERT ON "MailQueue" FOR EACH ROW EXECUTE FUNCTION ${trigger}();`);
      try {
        assert.equal((await retry(i.id)).status, 500);
        assert.equal(row(i.id).RevokedAt, null);
        assert.equal(
          sql(`SELECT count(*) FROM "Invitations" WHERE "Email"='${i.email}'`),
          "1",
        );
        assert.equal(
          sql(
            `SELECT count(*) FROM "AuditEvents" WHERE "Action"='invitation.delivery-retried' AND "Subject" LIKE '${i.id}%'`,
          ),
          "0",
        );
        assert.equal(job(i.id).Status, "Dead");
      } finally {
        sql(
          `DROP TRIGGER ${trigger} ON "MailQueue"; DROP FUNCTION ${trigger}();`,
        );
      }
      assert.equal((await retry(i.id)).status, 201);
    },
  );
  let replacement;
  await t.test(
    "simultaneous retries create one replacement, preserve scope/deadline and revoke the old secret",
    async () => {
      const oldToken = randomBytes(32).toString("hex").toUpperCase();
      const hash = createHash("sha256")
        .update(oldToken)
        .digest("hex")
        .toUpperCase();
      sql(
        `UPDATE "Invitations" SET "TokenHash"='${hash}' WHERE "Id"='${candidate.id}'`,
      );
      assert.equal(
        (await guest.call("/api/invitations/preview", { token: oldToken }))
          .status,
        200,
      );
      const before = row(candidate.id),
        originalJob = job(candidate.id);
      const results = await Promise.all([
        retry(candidate.id),
        retry(candidate.id),
      ]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      replacement = results.find((r) => r.status === 201).data;
      assert.equal(replacement.replacedInvitationId, candidate.id);
      const after = row(replacement.id);
      for (const field of [
        "TenantId",
        "Email",
        "NormalizedEmail",
        "Role",
        "BranchId",
        "ExpiresAt",
      ])
        assert.equal(after[field], before[field]);
      assert.notEqual(after.TokenHash, before.TokenHash);
      assert.ok(row(candidate.id).RevokedAt);
      assert.deepEqual(job(candidate.id), originalJob); // No revival or modification of the dead job.
      assert.equal(job(replacement.id).Status, "Pending");
      assert.equal(job(replacement.id).Attempts, 0);
      assert.equal((await retry(candidate.id)).status, 409);
      assert.equal(
        (await guest.call("/api/invitations/preview", { token: oldToken }))
          .status,
        400,
      );
      const audit = JSON.parse(
        sql(
          `SELECT row_to_json(a) FROM "AuditEvents" a WHERE "Action"='invitation.delivery-retried' AND "Subject"='${candidate.id} -> ${replacement.id}'`,
        ),
      );
      assert.equal(audit.ActorId, adminId);
      assert.equal(audit.TenantId, alpha);
      assert.equal(audit.BranchId, branch);
      assert.ok(
        !(await other.call(`/api/tenants/${beta}/audit`)).data.items.some(
          (a) => a.subject === audit.Subject,
        ),
      );
    },
  );
  await t.test(
    "request fields cannot change recipient, role, branch or organization",
    async () => {
      const r = await retry(foreign.id, other, beta, {
        email: "override@campusnexa.test",
        role: "Viewer",
        branchId: branch,
        tenantId: alpha,
      });
      assert.equal(r.status, 201);
      const i = row(r.data.id);
      assert.equal(i.Email, foreign.email);
      assert.equal(i.Role, "OrganizationAdmin");
      assert.equal(i.BranchId, null);
      assert.equal(i.TenantId, beta);
    },
  );
  await t.test(
    "replacement is delivered once normally and its acceptance preserves branch permissions",
    async () => {
      docker(["up", "-d", "--no-deps", "worker"]);
      const mail = await waitForMail(
        inbox,
        candidate.email,
        "Your CampusNexa invitation",
      );
      const token = mail.Text.match(/#invite=([A-F0-9]{64})/)[1];
      assert.equal(
        (
          await guest.call("/api/invitations/accept", {
            token,
            displayName: "Delivery Fixture",
            password: "DeliveryFixture!4680",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await guest.call("/api/invitations/accept", {
            token,
            displayName: "Delivery Fixture",
            password: "DeliveryFixture!4680",
          })
        ).status,
        400,
      );
      assert.equal((await retry(replacement.id)).status, 409);
      const membership = JSON.parse(
        sql(
          `SELECT row_to_json(m) FROM "Memberships" m JOIN "AspNetUsers" u ON u."Id"=m."UserId" WHERE u."Email"='${candidate.email}'`,
        ),
      );
      assert.equal(membership.TenantId, alpha);
      assert.equal(membership.Role, "Viewer");
      assert.equal(membership.BranchId, branch);
      for (
        let n = 0;
        n < 30 && (await listed(replacement.id)).delivery.status !== "Sent";
        n++
      )
        await new Promise((r) => setTimeout(r, 100));
      const visible = (await listed(replacement.id)).delivery;
      assert.equal(visible.status, "Sent");
      assert.equal(visible.attempts, 1);
      assert.equal(visible.nextAttemptAt, null);
      assert.ok(visible.completedAt);
      assert.equal(
        (
          await guest.call("/api/auth/forgot-password", {
            email: candidate.email,
          })
        ).status,
        200,
      );
      const list = (await admin.call(path())).data.items;
      assert.ok(
        list.every(
          (i) => !Object.hasOwn(i, "userId") && !Object.hasOwn(i, "payload"),
        ),
      );
      assert.ok(!JSON.stringify(list).includes("Recovery"));
      const messages = await (
        await fetch(inbox + "/api/v1/messages?limit=200")
      ).json();
      assert.equal(
        messages.messages.filter(
          (m) =>
            m.Subject === "Your CampusNexa invitation" &&
            m.To.some((to) => to.Address === candidate.email),
        ).length,
        1,
      );
    },
  );
});
