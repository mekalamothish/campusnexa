import { test } from "node:test";
import {waitForMail} from './mail-helper.mjs';
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
const base = "http://127.0.0.1:4200",
  inbox = "http://127.0.0.1:8025",
  alpha = "11111111-1111-1111-1111-111111111111",
  beta = "22222222-2222-2222-2222-222222222222";
if (process.env.ALLOW_FIXTURE_WRITES !== "1" || !process.env.ADMIN_PASSWORD)
  throw new Error("Load .env and set ALLOW_FIXTURE_WRITES=1.");
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
    const setCookies = r.headers.getSetCookie();
    for (const c of setCookies) {
      const pair = c.split(";")[0],
        n = pair.indexOf("=");
      if (pair.slice(n + 1))
        this.cookies.set(pair.slice(0, n), pair.slice(n + 1));
      else this.cookies.delete(pair.slice(0, n));
    }
    const s = await r.text();
    let data;
    try {
      data = JSON.parse(s);
    } catch {
      data = s;
    }
    return { status: r.status, data, setCookies };
  }
  async csrf() {
    assert.equal((await this.request("/api/auth/csrf")).status, 204);
  }
  async login(email, password = process.env.ADMIN_PASSWORD) {
    await this.csrf();
    const r = await this.request("/api/auth/login", "POST", {
      email,
      password,
    });
    await this.csrf();
    return r;
  }
}
async function tokenFor(email, kind) {
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
  const bytes = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = createHmac("sha1", bytes).update(counter).digest(),
    o = h[19] & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
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
      "-Atc",
      q,
    ],
    { encoding: "utf8" },
  ).trim();

test("Account-wide MFA lifecycle and isolation", async (t) => {
  const admin = new Client(),
    user = new Client(),
    old = new Client(),
    anon = new Client();
  await anon.csrf();
  assert.equal((await admin.login("admin@campusnexa.test")).status, 204);
  const email = `mfa-${Date.now().toString(36)}@campusnexa.test`;
  let password = "MfaOriginalPassword!4782",
    key,
    codes,
    id,
    usedCode;
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
        token: await tokenFor(email, "invite"),
        displayName: "MFA Test",
        password,
      })
    ).status,
    200,
  );
  assert.equal((await user.login(email, password)).status, 204);
  assert.equal((await old.login(email, password)).status, 204);
  id = (await user.request("/api/auth/me")).data.id;
  await t.test(
    "authenticated setup requires password and CSRF, never accepts target account",
    async () => {
      assert.equal((await anon.request("/api/auth/mfa/status")).status, 401);
      assert.equal(
        (await user.request("/api/auth/mfa/setup", "POST", { password }, false))
          .status,
        400,
      );
      assert.equal(
        (
          await user.request("/api/auth/mfa/setup", "POST", {
            password: "wrong",
          })
        ).status,
        400,
      );
      const setup = await user.request("/api/auth/mfa/setup", "POST", {
        password,
        userId: "other",
        tenantId: beta,
      });
      assert.equal(setup.status, 200);
      key = setup.data.sharedKey;
      assert.match(key, /^[A-Z2-7]+$/);
      await user.csrf();
      assert.equal(
        (await user.request("/api/auth/mfa/status")).data.enabled,
        false,
      );
      assert.equal(
        (await admin.request("/api/auth/mfa/status")).data.enabled,
        false,
      );
      assert.equal((await old.request("/api/auth/me")).status, 401);
    },
  );
  await t.test(
    "enable needs valid TOTP; recovery codes stored as hashes and scope preserved",
    async () => {
      assert.equal(
        (
          await user.request("/api/auth/mfa/enable", "POST", {
            password,
            code: "invalid",
          })
        ).status,
        400,
      );
      usedCode = totp(key);
      const r = await user.request("/api/auth/mfa/enable", "POST", {
        password,
        code: usedCode,
      });
      assert.equal(r.status, 200);
      codes = r.data.recoveryCodes;
      assert.equal(codes.length, 10);
      assert.equal(new Set(codes).size, 10);
      await user.csrf();
      const persisted = sql(
        `SELECT "Value" FROM "AspNetUserTokens" WHERE "UserId"='${id}' AND "Name"='RecoveryHashes'`,
      );
      for (const code of codes) assert.ok(!persisted.includes(code));
      const state = (await user.request("/api/auth/mfa/status")).data;
      assert.deepEqual(state, { enabled: true, recoveryCodesRemaining: 10 });
      assert.ok(!JSON.stringify(state).includes(key));
      assert.equal(
        (await user.request(`/api/tenants/${beta}/branches`)).status,
        404,
      );
      assert.equal(
        (await user.request(`/api/tenants/${alpha}/invitations`)).status,
        403,
      );
    },
  );
  await t.test(
    "password alone yields protected challenge, never authenticated API access",
    async () => {
      const r = await old.login(email, password);
      assert.equal(r.status, 200);
      assert.equal(r.data.requiresMfa, true);
      assert.ok(
        r.setCookies.some(
          (c) =>
            c.includes("CampusNexa.MfaChallenge") &&
            c.includes("httponly") &&
            c.includes("samesite=strict"),
        ),
      );
      assert.equal((await old.request("/api/auth/me")).status, 401);
      assert.equal((await old.request("/api/auth/mfa/status")).status, 401);
      assert.equal(
        (
          await old.request(
            "/api/auth/mfa/verify",
            "POST",
            { code: totp(key, 1) },
            false,
          )
        ).status,
        400,
      );
      assert.equal(
        (await old.request("/api/auth/mfa/verify", "POST", { code: usedCode }))
          .status,
        400,
        "TOTP already used to enroll is rejected",
      );
      const cookie = old.cookies.get("CampusNexa.MfaChallenge");
      old.cookies.set("CampusNexa.MfaChallenge", cookie + "tampered");
      assert.equal(
        (
          await old.request("/api/auth/mfa/verify", "POST", {
            code: totp(key, 1),
          })
        ).status,
        400,
      );
      old.cookies.set("CampusNexa.MfaChallenge", cookie);
      const consumedCookie = new Map(old.cookies);
      assert.equal(
        (
          await old.request("/api/auth/mfa/verify", "POST", {
            code: totp(key, 1),
          })
        ).status,
        204,
      );
      await old.csrf();
      assert.equal((await old.request("/api/auth/me")).status, 200);
      const replay = new Client();
      replay.cookies = consumedCookie;
      assert.equal(
        (
          await replay.request("/api/auth/mfa/verify", "POST", {
            code: codes[0],
            recovery: true,
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    "recovery code consumed exactly once under concurrent challenges",
    async () => {
      const a = new Client();
      assert.equal((await a.login(email, password)).status, 200);
      const b = new Client();
      b.cookies = new Map(a.cookies);
      const results = await Promise.all([
        a.request("/api/auth/mfa/verify", "POST", {
          code: codes[0],
          recovery: true,
        }),
        b.request("/api/auth/mfa/verify", "POST", {
          code: codes[0],
          recovery: true,
        }),
      ]);
      assert.equal(results.filter((r) => r.status === 204).length, 1);
      assert.ok(results.every((r) => [204, 400, 409].includes(r.status)));
      assert.equal(
        (await user.request("/api/auth/mfa/status")).data
          .recoveryCodesRemaining,
        9,
      );
      const c = new Client();
      assert.equal((await c.login(email, password)).status, 200);
      assert.equal(
        (
          await c.request("/api/auth/mfa/verify", "POST", {
            code: codes[0],
            recovery: true,
          })
        ).status,
        400,
      );
    },
  );
  await t.test("new challenge supersedes old; inactive account cannot complete MFA", async () => {
    const first = new Client(), second = new Client();
    assert.equal((await first.login(email, password)).status, 200);
    assert.equal((await second.login(email, password)).status, 200);
    assert.equal((await first.request('/api/auth/mfa/verify', 'POST', {code:codes[8],recovery:true})).status, 400);
    try {
      sql(`UPDATE "AspNetUsers" SET "IsActive"=false WHERE "Id"='${id}'`);
      assert.equal((await second.request('/api/auth/mfa/verify', 'POST', {code:codes[8],recovery:true})).status, 400);
    } finally { sql(`UPDATE "AspNetUsers" SET "IsActive"=true WHERE "Id"='${id}'`); }
  });
  await t.test(
    "password reset invalidates pending challenge but cannot bypass MFA",
    async () => {
      const pending = new Client();
      assert.equal((await pending.login(email, password)).status, 200);
      assert.equal(
        (await anon.request("/api/auth/forgot-password", "POST", { email }))
          .status,
        200,
      );
      password = "MfaReplacementPassword!5793";
      assert.equal(
        (
          await anon.request("/api/auth/reset-password", "POST", {
            email,
            token: await tokenFor(email, "reset"),
            password,
          })
        ).status,
        200,
      );
      await anon.csrf();
      assert.equal(
        (
          await pending.request("/api/auth/mfa/verify", "POST", {
            code: codes[1],
            recovery: true,
          })
        ).status,
        400,
      );
      assert.equal((await user.request("/api/auth/me")).status, 401);
      assert.equal((await user.login(email, password)).status, 200);
      assert.equal((await user.request("/api/auth/me")).status, 401);
      assert.equal(
        (
          await user.request("/api/auth/mfa/verify", "POST", {
            code: codes[1],
            recovery: true,
          })
        ).status,
        204,
      );
      await user.csrf();
      assert.equal(
        (await user.request("/api/auth/mfa/status")).data.enabled,
        true,
      );
    },
  );
  await t.test(
    "replace codes requires password plus factor, invalidates old codes and sessions",
    async () => {
      assert.equal((await old.login(email, password)).status, 200);
      assert.equal(
        (
          await old.request("/api/auth/mfa/verify", "POST", {
            code: codes[2],
            recovery: true,
          })
        ).status,
        204,
      );
      await old.csrf();
      assert.equal(
        (
          await user.request("/api/auth/mfa/recovery-codes", "POST", {
            password,
            code: "invalid",
          })
        ).status,
        400,
      );
      const r = await user.request("/api/auth/mfa/recovery-codes", "POST", {
        password,
        code: codes[3],
        recovery: true,
      });
      assert.equal(r.status, 200);
      await user.csrf();
      assert.equal((await old.request("/api/auth/me")).status, 401);
      assert.equal((await old.login(email, password)).status, 200);
      assert.equal(
        (
          await old.request("/api/auth/mfa/verify", "POST", {
            code: codes[4],
            recovery: true,
          })
        ).status,
        400,
      );
      codes = r.data.recoveryCodes;
      assert.equal(codes.length, 10);
    },
  );
  await t.test(
    "five failed second factors lock the account and password cannot clear lockout",
    async () => {
      // Clear earlier failure count through successful full MFA, not direct test SQL.
      assert.equal(
        (
          await old.request("/api/auth/mfa/verify", "POST", {
            code: codes[0],
            recovery: true,
          })
        ).status,
        204,
      );
      await old.csrf();
      const locked = new Client();
      assert.equal((await locked.login(email, password)).status, 200);
      for (let n = 0; n < 5; n++)
        assert.equal(
          (
            await locked.request("/api/auth/mfa/verify", "POST", {
              code: "bad",
            })
          ).status,
          400,
        );
      assert.equal(
        (
          await locked.request("/api/auth/mfa/verify", "POST", {
            code: codes[1],
            recovery: true,
          })
        ).status,
        400,
      );
      assert.equal((await locked.login(email, password)).status, 401);
      // Only this test-created user's temporary lockout is cleared to exercise disable next.
      sql(
        `UPDATE "AspNetUsers" SET "LockoutEnd"=NULL,"AccessFailedCount"=0 WHERE "Id"='${id}'`,
      );
    },
  );
  await t.test(
    "disable requires both factors, revokes sessions, removes codes and restores password login",
    async () => {
      assert.equal(
        (
          await user.request("/api/auth/mfa/disable", "POST", {
            password,
            code: "bad",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await user.request("/api/auth/mfa/disable", "POST", {
            password,
            code: codes[1],
            recovery: true,
          })
        ).status,
        200,
      );
      await user.csrf();
      assert.deepEqual((await user.request("/api/auth/mfa/status")).data, {
        enabled: false,
        recoveryCodesRemaining: 0,
      });
      assert.equal((await old.request("/api/auth/me")).status, 401);
      assert.equal((await old.login(email, password)).status, 204);
      assert.equal(
        (await old.request(`/api/tenants/${beta}/branches`)).status,
        404,
      );
      assert.equal(
        (await admin.request("/api/auth/mfa/status")).data.enabled,
        false,
      );
    },
  );
  await t.test("MFA endpoint rate limit is enforced", async () => {
    let limited=false;
    for(let n=0;n<31;n++) {
      const result=await user.request('/api/auth/mfa/status');
      if(result.status===429){limited=true;break;}
      assert.equal(result.status,200);
    }
    assert.ok(limited);
  });
});
