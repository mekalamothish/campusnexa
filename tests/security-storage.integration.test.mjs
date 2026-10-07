import { test } from "node:test";
import {waitForMail} from './mail-helper.mjs';
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

if (process.env.ALLOW_FIXTURE_WRITES !== "1" || !process.env.ADMIN_PASSWORD)
  throw new Error(
    "Load .env and set ALLOW_FIXTURE_WRITES=1. Local fictional data only.",
  );
const base = "http://127.0.0.1:4200",
  inbox = "http://127.0.0.1:8025",
  alpha = "11111111-1111-1111-1111-111111111111";
class Client {
  cookies = new Map();
  async request(path, method = "GET", body, extra = {}) {
    const headers = {
      ...extra,
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    if (this.cookies.has("XSRF-TOKEN"))
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
      if (pair.slice(n + 1))
        this.cookies.set(pair.slice(0, n), pair.slice(n + 1));
      else this.cookies.delete(pair.slice(0, n));
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
  async login(email, password) {
    await this.csrf();
    const r = await this.request("/api/auth/login", "POST", {
      email,
      password,
    });
    await this.csrf();
    return r;
  }
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
      "-At",
    ],
    { input: q, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
async function mailToken(email, kind) {
  const mail = await waitForMail(inbox, email, kind === 'invite' ? 'Your CampusNexa invitation' : 'Reset your CampusNexa password');
  return new URLSearchParams(
    new URL(
      mail.Text.match(/http:\/\/127\.0\.0\.1:4200\/#[^\s]+/)[0],
    ).hash.slice(1),
  ).get(kind);
}
function totp(key, offset = 0) {
  const bits = [...key]
    .map((c) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(c)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("");
  const bytes = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = createHmac("sha1", bytes).update(counter).digest(),
    o = h[19] & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}
const migrate = () =>
  spawnSync(
    "docker",
    ["compose", "run", "--rm", "--no-deps", "api", "--migrate"],
    { encoding: "utf8", timeout: 45000 },
  );
const keyRow = (id) =>
  `"UserId"='${id}' AND "LoginProvider"='[AspNetUserStore]' AND "Name"='AuthenticatorKey'`;

test("Encrypted authenticator storage and private security history", async (t) => {
  const admin = new Client(),
    anon = new Client(),
    a = new Client(),
    b = new Client();
  await anon.csrf();
  assert.equal(
    (await admin.login("admin@campusnexa.test", process.env.ADMIN_PASSWORD))
      .status,
    204,
  );
  const suffix = Date.now().toString(36),
    email = `storage-a-${suffix}@campusnexa.test`,
    emailB = `storage-b-${suffix}@campusnexa.test`;
  let password = "StorageOriginal!2468";
  const branch = (
    await admin.request(`/api/tenants/${alpha}/branches`)
  ).data.find((x) => x.code === "MAIN");
  for (const [address, client] of [
    [email, a],
    [emailB, b],
  ]) {
    assert.equal(
      (
        await admin.request(`/api/tenants/${alpha}/invitations`, "POST", {
          email: address,
          role: "Viewer",
          branchId: branch.id,
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await anon.request("/api/invitations/accept", "POST", {
          token: await mailToken(address, "invite"),
          displayName: "Storage Check",
          password,
        })
      ).status,
      200,
    );
    assert.equal((await client.login(address, password)).status, 204);
  }
  const id = (await a.request("/api/auth/me")).data.id,
    idB = (await b.request("/api/auth/me")).data.id;
  let key, keyB, cipher, cipherB, codes;
  await t.test(
    "new authenticator keys encrypted and MFA still enrolls",
    async () => {
      const one = await a.request("/api/auth/mfa/setup", "POST", { password }),
        two = await b.request("/api/auth/mfa/setup", "POST", { password });
      assert.equal(one.status, 200);
      assert.equal(two.status, 200);
      await a.csrf();
      await b.csrf();
      key = one.data.sharedKey;
      keyB = two.data.sharedKey;
      cipher = sql(
        `SELECT "Value" FROM "AspNetUserTokens" WHERE ${keyRow(id)};`,
      );
      cipherB = sql(
        `SELECT "Value" FROM "AspNetUserTokens" WHERE ${keyRow(idB)};`,
      );
      assert.ok(cipher.startsWith("cnx-ak:v1:"));
      assert.ok(!cipher.includes(key));
      assert.ok(!cipherB.includes(keyB));
      const r = await a.request("/api/auth/mfa/enable", "POST", {
        password,
        code: totp(key),
      });
      assert.equal(r.status, 200);
      codes = r.data.recoveryCodes;
      await a.csrf();
    },
  );
  await t.test(
    "ciphertext copied from another account fails closed without exposing secrets",
    async () => {
      const pending = new Client();
      assert.equal((await pending.login(email, password)).status, 200);
      try {
        sql(
          `UPDATE "AspNetUserTokens" SET "Value"='${cipherB}' WHERE ${keyRow(id)};`,
        );
        const r = await pending.request("/api/auth/mfa/verify", "POST", {
          code: totp(key, 1),
        });
        assert.equal(r.status, 503);
        assert.ok(!JSON.stringify(r).includes(key));
        assert.ok(!JSON.stringify(r).includes(cipherB));
        assert.equal((await pending.request("/api/auth/me")).status, 401);
      } finally {
        sql(
          `UPDATE "AspNetUserTokens" SET "Value"='${cipher}' WHERE ${keyRow(id)};`,
        );
      }
    },
  );
  await t.test(
    "legacy upgrade rolls back on corruption, then preserves key and is idempotent",
    async () => {
      try {
        sql(
          `UPDATE "AspNetUserTokens" SET "Value"='${key}' WHERE ${keyRow(id)}; UPDATE "AspNetUserTokens" SET "Value"='cnx-ak:v1:corrupt' WHERE ${keyRow(idB)};`,
        );
        const failed = migrate();
        assert.notEqual(failed.status, 0);
        assert.equal(
          sql(
            `SELECT "Value"='${key}' FROM "AspNetUserTokens" WHERE ${keyRow(id)};`,
          ),
          "t",
        );
        sql(
          `UPDATE "AspNetUserTokens" SET "Value"='${cipherB}' WHERE ${keyRow(idB)};`,
        );
        const upgraded = migrate();
        assert.equal(upgraded.status, 0);
        assert.match(upgraded.stdout, /1 legacy keys protected/);
        const rerun = migrate();
        assert.equal(rerun.status, 0);
        assert.match(rerun.stdout, /0 legacy keys protected/);
        const pending = new Client();
        assert.equal((await pending.login(email, password)).status, 200);
        assert.equal(
          (
            await pending.request("/api/auth/mfa/verify", "POST", {
              code: totp(key, 1),
            })
          ).status,
          204,
        );
      } finally {
        // Restore the two test-created key rows to valid ciphertext even when a check fails.
        sql(
          `UPDATE "AspNetUserTokens" SET "Value"='${cipher}' WHERE ${keyRow(id)}; UPDATE "AspNetUserTokens" SET "Value"='${cipherB}' WHERE ${keyRow(idB)};`,
        );
      }
    },
  );
  await t.test(
    "history is own-account only, including against same-school administrators",
    async () => {
      assert.equal(
        (await anon.request("/api/auth/security-events")).status,
        401,
      );
      const history = (await a.request("/api/auth/security-events")).data,
        other = (await b.request("/api/auth/security-events")).data,
        administrative = (
          await admin.request("/api/auth/security-events?userId=" + id)
        ).data;
      const ownIds = new Set(history.map((x) => x.id));
      assert.ok(history.some((x) => x.action === "MfaEnabled"));
      assert.ok(history.some((x) => x.action === "AuthenticatorKeyProtected"));
      assert.ok(other.every((x) => !ownIds.has(x.id)));
      assert.ok(administrative.every((x) => !ownIds.has(x.id)));
      assert.deepEqual(
        (
          await a.request(
            "/api/auth/security-events?userId=" + idB,
            "GET",
            undefined,
            { "X-User-ID": idB, "X-Tenant-ID": alpha },
          )
        ).data,
        history,
      );
      assert.equal(
        (await admin.request("/api/auth/security-events/" + id)).status,
        404,
      );
      for (const event of history)
        assert.deepEqual(Object.keys(event).sort(), [
          "action",
          "id",
          "occurredAt",
        ]);
      for (const secret of [key, keyB, password, email, cipher, ...codes])
        assert.ok(!JSON.stringify(history).includes(secret));
    },
  );
  await t.test(
    "audit failure rolls back password reset, then same token can succeed",
    async () => {
      assert.equal(
        (await anon.request("/api/auth/forgot-password", "POST", { email }))
          .status,
        200,
      );
      const token = await mailToken(email, "reset"),
        replacement = "StorageReplacement!3579";
      const stamp = sql(
        `SELECT "SecurityStamp" FROM "AspNetUsers" WHERE "Id"='${id}';`,
      );
      const fn = "security_test_" + suffix;
      try {
        sql(
          `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."UserId"='${id}' AND NEW."Action"='PasswordReset' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ${fn} BEFORE INSERT ON "SecurityEvents" FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
        );
        assert.equal(
          (
            await anon.request("/api/auth/reset-password", "POST", {
              email,
              token,
              password: replacement,
            })
          ).status,
          500,
        );
        assert.equal(
          sql(
            `SELECT "SecurityStamp"='${stamp}' FROM "AspNetUsers" WHERE "Id"='${id}';`,
          ),
          "t",
        );
        assert.equal((await a.request("/api/auth/me")).status, 200);
      } finally {
        sql(
          `DROP TRIGGER IF EXISTS ${fn} ON "SecurityEvents"; DROP FUNCTION IF EXISTS ${fn}();`,
        );
      }
      assert.equal(
        (
          await anon.request("/api/auth/reset-password", "POST", {
            email,
            token,
            password: replacement,
          })
        ).status,
        200,
      );
      password = replacement;
      await anon.csrf();
      assert.equal((await a.request("/api/auth/me")).status, 401);
      assert.equal((await a.login(email, password)).status, 200);
      assert.equal(
        (
          await a.request("/api/auth/mfa/verify", "POST", {
            code: codes[0],
            recovery: true,
          })
        ).status,
        204,
      );
      await a.csrf();
      const events = (await a.request("/api/auth/security-events")).data;
      assert.equal(
        events.filter((x) => x.action === "PasswordReset").length,
        1,
      );
      assert.ok(events.some((x) => x.action === "PasswordRecoveryRequested"));
      assert.ok(events.some((x) => x.action === "RecoveryCodeSignIn"));
    },
  );
  await t.test(
    "session revocation and known-account failures recorded without widening access",
    async () => {
      assert.equal(
        (await a.request("/api/auth/revoke-sessions", "POST")).status,
        204,
      );
      assert.equal((await a.login(email, "wrong-password")).status, 401);
      assert.equal((await a.login(email, password)).status, 200);
      assert.equal(
        (
          await a.request("/api/auth/mfa/verify", "POST", {
            code: codes[1],
            recovery: true,
          })
        ).status,
        204,
      );
      await a.csrf();
      const events = (await a.request("/api/auth/security-events")).data;
      assert.ok(events.some((x) => x.action === "SessionsRevoked"));
      assert.ok(events.some((x) => x.action === "SignInFailed"));
    },
  );
  await t.test("history list is bounded and newest-first", async () => {
    sql(
      `INSERT INTO "SecurityEvents" ("Id","UserId","Action","OccurredAt") SELECT gen_random_uuid(),'${id}','SignedOut',now()-n*interval '1 second' FROM generate_series(1,105) AS n;`,
    );
    const rows = (await a.request("/api/auth/security-events")).data;
    assert.equal(rows.length, 100);
    for (let i = 1; i < rows.length; i++)
      assert.ok(
        new Date(rows[i - 1].occurredAt) >= new Date(rows[i].occurredAt),
      );
  });
});
