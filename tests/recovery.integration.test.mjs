import { test } from "node:test";
import {waitForMail} from './mail-helper.mjs';
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const base = "http://127.0.0.1:4200",
  inbox = "http://127.0.0.1:8025";
if (process.env.ALLOW_FIXTURE_WRITES !== "1" || !process.env.ADMIN_PASSWORD)
  throw new Error("Load .env and set ALLOW_FIXTURE_WRITES=1.");
const alpha = "11111111-1111-1111-1111-111111111111",
  beta = "22222222-2222-2222-2222-222222222222";
class Client {
  cookies = new Map();
  async request(path, method = "GET", body, csrf = true) {
    const headers = {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    if (csrf && this.cookies.has("XSRF-TOKEN"))
      headers["X-XSRF-TOKEN"] = decodeURIComponent(
        this.cookies.get("XSRF-TOKEN"),
      );
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    for (const c of r.headers.getSetCookie()) {
      const pair = c.split(";")[0],
        n = pair.indexOf("=");
      this.cookies.set(pair.slice(0, n), pair.slice(n + 1));
    }
    const value = await r.text();
    let data;
    try {
      data = JSON.parse(value);
    } catch {
      data = value;
    }
    return { status: r.status, data };
  }
  async csrf() {
    assert.equal((await this.request("/api/auth/csrf")).status, 204);
  }
  async login(email, password = process.env.ADMIN_PASSWORD) {
    await this.csrf();
    assert.equal(
      (await this.request("/api/auth/login", "POST", { email, password }))
        .status,
      204,
    );
    await this.csrf();
  }
}
async function messages(email, subject) {
  const list = await (await fetch(inbox + "/api/v1/messages?limit=200")).json();
  return list.messages.filter(
    (m) => m.To.some((to) => to.Address === email) && m.Subject === subject,
  );
}
async function linkFor(email, kind) {
  const mail = await waitForMail(inbox, email, kind === 'invite' ? 'Your CampusNexa invitation' : 'Reset your CampusNexa password');
  const link = mail.Text.match(/http:\/\/127\.0\.0\.1:4200\/#[^\s]+/)[0];
  return new URLSearchParams(new URL(link).hash.slice(1)).get(kind);
}
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
    { encoding: "utf8" },
  ).trim();

test("Local account recovery", async (t) => {
  const admin = new Client(),
    anon = new Client(),
    active = new Client(),
    secondSession = new Client();
  await admin.login("admin@campusnexa.test");
  await anon.csrf();
  const email = `recovery-${Date.now().toString(36)}@campusnexa.test`,
    oldPassword = "RecoveryOriginal!2468",
    password = "RecoveryReplacement!3579";
  const branch = (
    await admin.request(`/api/tenants/${alpha}/branches`)
  ).data.find((b) => b.code === "MAIN");
  assert.equal(
    (
      await admin.request(`/api/tenants/${alpha}/invitations`, "POST", {
        email,
        role: "Viewer",
        branchId: branch.id,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await anon.request("/api/invitations/accept", "POST", {
        token: await linkFor(email, "invite"),
        displayName: "Recovery Test",
        password: oldPassword,
      })
    ).status,
    200,
  );
  await active.login(email, oldPassword);
  await secondSession.login(email, oldPassword);
  const before = (await active.request("/api/auth/me")).data;
  let token;
  await t.test(
    "CSRF required and generic acknowledgement does not expose accounts",
    async () => {
      assert.equal(
        (
          await anon.request(
            "/api/auth/forgot-password",
            "POST",
            { email },
            false,
          )
        ).status,
        400,
      );
      const known = await anon.request("/api/auth/forgot-password", "POST", {
        email,
      });
      assert.equal(known.status, 200);
      const unknown = await anon.request("/api/auth/forgot-password", "POST", {
        email: `absent-${Date.now()}@campusnexa.test`,
      });
      const invalid = await anon.request("/api/auth/forgot-password", "POST", {
        email: "invalid",
      });
      assert.deepEqual(unknown, known);
      assert.deepEqual(invalid, known);
      token = await linkFor(email, "reset");
      assert.ok(!JSON.stringify(known).includes(token));
      assert.equal(
        (await active.request("/api/auth/me")).status,
        200,
        "Request must not revoke sessions",
      );
    },
  );
  await t.test(
    "inactive and unconfirmed accounts receive no recovery mail",
    async () => {
      const count = (await messages(email, "Reset your CampusNexa password"))
        .length;
      try {
        sql(
          `UPDATE "AspNetUsers" SET "IsActive"=false WHERE "Id"='${before.id}'`,
        );
        assert.equal(
          (await anon.request("/api/auth/forgot-password", "POST", { email }))
            .status,
          200,
        );
        assert.equal(
          (
            await anon.request("/api/auth/reset-password", "POST", {
              email,
              token,
              password,
            })
          ).status,
          400,
        );
        sql(
          `UPDATE "AspNetUsers" SET "IsActive"=true,"EmailConfirmed"=false WHERE "Id"='${before.id}'`,
        );
        assert.equal(
          (await anon.request("/api/auth/forgot-password", "POST", { email }))
            .status,
          200,
        );
        assert.equal(
          (
            await anon.request("/api/auth/reset-password", "POST", {
              email,
              token,
              password,
            })
          ).status,
          400,
        );
        assert.equal(
          (await messages(email, "Reset your CampusNexa password")).length,
          count,
        );
      } finally {
        sql(
          `UPDATE "AspNetUsers" SET "IsActive"=true,"EmailConfirmed"=true WHERE "Id"='${before.id}'`,
        );
      }
    },
  );
  await t.test(
    "token substitution, malformed token, CSRF and weak-password rejection",
    async () => {
      assert.equal(
        (
          await anon.request(
            "/api/auth/reset-password",
            "POST",
            { email, token, password },
            false,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await anon.request("/api/auth/reset-password", "POST", {
            email: "other@campusnexa.test",
            token,
            password,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await anon.request("/api/auth/reset-password", "POST", {
            email,
            token: "%%%invalid",
            password,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await anon.request("/api/auth/reset-password", "POST", {
            email,
            token: token.slice(0, -10) + "ABCDEFGHIJ",
            password,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await anon.request("/api/auth/reset-password", "POST", {
            email,
            token,
            password: "weak",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await anon.request("/api/auth/reset-password", "POST", {
            email,
            token,
            password: "alllowercasepassword",
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "reset invalidates both sessions and old password without changing scope",
    async () => {
      assert.equal(
        (
          await anon.request("/api/auth/reset-password", "POST", {
            email,
            token,
            password,
            role: "OrganizationAdmin",
            tenantId: beta,
          })
        ).status,
        200,
      );
      assert.equal((await active.request("/api/auth/me")).status, 401);
      assert.equal((await secondSession.request("/api/auth/me")).status, 401);
      await anon.csrf();
      assert.equal(
        (await anon.request("/api/auth/me")).status,
        401,
        "No automatic login",
      );
      assert.equal(
        (
          await anon.request("/api/auth/login", "POST", {
            email,
            password: oldPassword,
          })
        ).status,
        401,
      );
      await active.login(email, password);
      assert.deepEqual(
        (await active.request("/api/auth/me")).data.memberships,
        before.memberships,
      );
      assert.equal(
        (await active.request(`/api/tenants/${alpha}/invitations`)).status,
        403,
      );
      assert.equal(
        (await active.request(`/api/tenants/${beta}/branches`)).status,
        404,
      );
      assert.equal(
        (
          await anon.request("/api/auth/reset-password", "POST", {
            email,
            token,
            password: oldPassword,
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "concurrent reset allows exactly one winner and invalidates sibling links",
    async () => {
      assert.equal(
        (await anon.request("/api/auth/forgot-password", "POST", { email }))
          .status,
        200,
      );
      const sibling = await linkFor(email, "reset");
      assert.equal(
        (await anon.request("/api/auth/forgot-password", "POST", { email }))
          .status,
        200,
      );
      const current = await linkFor(email, "reset");
      const finalPassword = "ConcurrentRecovery!4680";
      const results = await Promise.all([
        anon.request("/api/auth/reset-password", "POST", {
          email,
          token: current,
          password: finalPassword,
        }),
        anon.request("/api/auth/reset-password", "POST", {
          email,
          token: current,
          password: finalPassword,
        }),
      ]);
      assert.equal(results.filter((r) => r.status === 200).length, 1);
      assert.ok(results.every((r) => [200, 400, 409].includes(r.status)));
      await anon.csrf();
      assert.equal(
        (
          await anon.request("/api/auth/reset-password", "POST", {
            email,
            token: sibling,
            password,
          })
        ).status,
        400,
      );
      await secondSession.login(email, finalPassword);
    },
  );
  await t.test(
    "unrelated fixture credentials and permissions remain unchanged",
    async () => {
      const other = new Client();
      await other.login("other@campusnexa.test");
      assert.equal(
        (await other.request(`/api/tenants/${alpha}/branches`)).status,
        404,
      );
      assert.equal(
        (await admin.request(`/api/tenants/${alpha}/branches`)).status,
        200,
      );
    },
  );
  await t.test("recovery request and reset endpoints enforce rate limits", async () => {
    // Run last: these deliberate limit checks exhaust this local proxy's windows.
    await anon.csrf();
    for (const [path, limit] of [["forgot-password", 10], ["reset-password", 20]]) {
      let limited = false;
      for (let n = 0; n <= limit; n++) {
        const result = await anon.request(`/api/auth/${path}`, "POST", { email: "not-an-email" });
        if (result.status === 429) { limited = true; break; }
        assert.ok([200, 400].includes(result.status));
      }
      assert.ok(limited, `${path} should reject excess requests`);
    }
  });
});
