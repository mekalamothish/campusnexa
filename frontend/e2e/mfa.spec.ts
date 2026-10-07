import { test, expect } from "@playwright/test";
import {waitForMail} from './mail-helper';
import { createHmac } from "node:crypto";
import { resolve } from "node:path";

function totp(key: string) {
  const bits = [...key]
    .map((c) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(c)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("");
  const bytes = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", bytes).update(counter).digest(),
    o = h[19]! & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}

test("mobile MFA enrollment, challenge, existing-account invitation and disable", async ({
  page,
  request,
  baseURL,
}) => {
  const csrf = async () => {
    await request.get("/api/auth/csrf");
    const cookies = (await request.storageState()).cookies;
    return {
      "X-XSRF-TOKEN": decodeURIComponent(
        cookies.find((c) => c.name === "XSRF-TOKEN")!.value,
      ),
    };
  };
  let headers = await csrf();
  expect(
    (
      await request.post("/api/auth/login", {
        headers,
        data: {
          email: "admin@campusnexa.test",
          password: process.env["ADMIN_PASSWORD"],
        },
      })
    ).status(),
  ).toBe(204);
  headers = await csrf();
  const alpha = "11111111-1111-1111-1111-111111111111",
    beta = "22222222-2222-2222-2222-222222222222",
    email = `browser-mfa-${Date.now().toString(36)}@campusnexa.test`,
    password = "BrowserMfaPassword!4680";
  const branch = (
    await (await request.get(`/api/tenants/${alpha}/branches`)).json()
  ).find((b: { code: string }) => b.code === "MAIN");
  expect(
    (
      await request.post(`/api/tenants/${alpha}/invitations`, {
        headers,
        data: { email, role: "Viewer", branchId: branch.id },
      })
    ).status(),
  ).toBe(201);
  const inbox = process.env["MAIL_URL"] ?? "http://127.0.0.1:8025";
  const invitation = async () => {
    const mail = await waitForMail(request,inbox,email,'Your CampusNexa invitation');
    return mail.Text.match(/#invite=([A-F0-9]{64})/)[1];
  };
  const token = await invitation();
  await request.post("/api/auth/logout", { headers });
  headers = await csrf();
  expect(
    (
      await request.post("/api/invitations/accept", {
        headers,
        data: { token, displayName: "MFA Browser", password },
      })
    ).status(),
  ).toBe(200);
  const signIn = async () => {
    await page.goto("/");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in to workspace" }).click();
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn();
  await expect(
    page.getByRole("heading", { name: "A clear view of your school." }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Account security" })
    .click();
  await page.getByLabel("Current password").fill(password);
  await page
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  const key = await page.getByTestId("setup-key").innerText();
  expect(key).toMatch(/^[A-Z2-7]+$/);
  await page.getByLabel("Current password").fill(password);
  await page.getByLabel("Security code", { exact: true }).fill(totp(key));
  await page.getByRole("button", { name: "Enable MFA", exact: true }).click();
  await expect(page.getByText("MFA enabled", { exact: true })).toBeVisible();
  await expect(page.getByTestId("recovery-code")).toHaveCount(10);
  const history = page.getByTestId("security-history");
  await expect(
    history.getByText("Authenticator enabled", { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText("Authenticator setup started", { exact: true }),
  ).toBeVisible();
  const codes = await page.getByTestId("recovery-code").allTextContents();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve("../.runtime/screenshots/mfa-security-mobile.png"),
    fullPage: true,
    mask: [page.getByTestId("recovery-code")],
  });
  await page.getByRole("button", { name: "I saved my recovery codes" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn();
  await expect(
    page.getByRole("heading", { name: "Verify your sign-in." }),
  ).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.getByLabel("Verification code").fill("invalid");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Unable to verify");
  await page.screenshot({
    path: resolve("../.runtime/screenshots/mfa-challenge-mobile.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Verification method")
    .selectOption({ label: "Recovery code" });
  await page.getByLabel("Verification code").fill(codes[0]!);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "A clear view of your school." }),
  ).toBeVisible();
  // Invite this MFA-enabled account to another school and exercise the embedded challenge.
  headers = await csrf();
  expect(
    (
      await request.post("/api/auth/login", {
        headers,
        data: {
          email: "other@campusnexa.test",
          password: process.env["ADMIN_PASSWORD"],
        },
      })
    ).status(),
  ).toBe(204);
  headers = await csrf();
  const otherBranch = (
    await (await request.get(`/api/tenants/${beta}/branches`)).json()
  )[0];
  expect(
    (
      await request.post(`/api/tenants/${beta}/invitations`, {
        headers,
        data: { email, role: "Viewer", branchId: otherBranch.id },
      })
    ).status(),
  ).toBe(201);
  await page.goto(baseURL + "/#invite=" + (await invitation()));
  await page.getByLabel("Existing account password").fill(password);
  await page
    .getByRole("button", { name: "Sign in to invited account" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Verify your sign-in." }),
  ).toBeVisible();
  await page
    .getByLabel("Verification method")
    .selectOption({ label: "Recovery code" });
  await page.getByLabel("Verification code").fill(codes[1]!);
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(page.getByRole("status")).toContainText("Signed in.");
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Invitation accepted");
  await page.getByRole("link", { name: "Continue to sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "A clear view of your school." }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Account security" })
    .click();
  await page.getByLabel("Current password").fill(password);
  await page
    .getByLabel("Second-factor method")
    .selectOption({ label: "Unused recovery code" });
  await page.getByLabel("Security code", { exact: true }).fill(codes[2]!);
  await page
    .getByLabel("I understand disabling MFA removes second-step protection.")
    .check();
  await page.getByRole("button", { name: "Disable MFA", exact: true }).click();
  await expect(
    page.getByText("MFA not enabled", { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText("Authenticator disabled", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Account security" })
    .click();
  await history
    .getByRole("button", { name: "Refresh security history" })
    .click();
  await expect(
    history.getByText("Authenticator disabled", { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText("Second-step verification failed", { exact: true }),
  ).toBeVisible();
  expect(
    await history
      .locator(".table-scroll")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve("../.runtime/screenshots/security-history-mobile.png"),
    fullPage: true,
  });
});
