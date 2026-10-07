import { test, expect } from "@playwright/test";
import {waitForMail} from './mail-helper';
import { resolve } from "node:path";

test("mobile password recovery, confirmation, reset and invalid-link navigation", async ({
  page,
  request,
  baseURL,
}) => {
  // Create a unique account through invitation APIs; never reset shared fixture credentials.
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
  const tenant = "11111111-1111-1111-1111-111111111111";
  const branches = await (
    await request.get(`/api/tenants/${tenant}/branches`)
  ).json();
  const email = `browser-recovery-${Date.now().toString(36)}@campusnexa.test`;
  expect(
    (
      await request.post(`/api/tenants/${tenant}/invitations`, {
        headers,
        data: {
          email,
          role: "Viewer",
          branchId: branches.find((b: { code: string }) => b.code === "MAIN")
            .id,
        },
      })
    ).status(),
  ).toBe(201);
  const inbox = process.env["MAIL_URL"] ?? "http://127.0.0.1:8025";
  const link = async (subject: string, kind: string) => {
    const mail = await waitForMail(request,inbox,email,subject);
    const fragment = mail.Text.match(
      /http:\/\/127\.0\.0\.1:4200\/(#[^\s]+)/,
    )[1];
    return new URLSearchParams(fragment.slice(1)).get(kind)!;
  };
  const invite = await link("Your CampusNexa invitation", "invite");
  await request.post("/api/auth/logout", { headers });
  headers = await csrf();
  expect(
    (
      await request.post("/api/invitations/accept", {
        headers,
        data: {
          token: invite,
          displayName: "Browser Recovery",
          password: "OriginalBrowser!1234",
        },
      })
    ).status(),
  ).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(
    page.getByRole("heading", { name: "Forgot your password?" }),
  ).toBeVisible();
  await page.getByLabel("Account email").fill(email);
  await page.getByRole("button", { name: "Send recovery link" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If an eligible account exists",
  );
  const token = await link("Reset your CampusNexa password", "reset");
  await page.goto(
    baseURL +
      "/#reset=" +
      encodeURIComponent(token) +
      "&email=" +
      encodeURIComponent(email),
  );
  await expect(
    page.getByRole("heading", { name: "Choose a new password." }),
  ).toBeVisible();
  expect(page.url()).not.toContain(token);
  await page
    .getByLabel("New password", { exact: true })
    .fill("ReplacementBrowser!2468");
  await page.getByLabel("Confirm new password").fill("DifferentBrowser!2468");
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "The passwords do not match.",
  );
  await page.getByLabel("Confirm new password").fill("ReplacementBrowser!2468");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve("../.runtime/screenshots/recovery-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Password updated");
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await page.getByLabel("Email address").fill(email);
  await page
    .getByLabel("Password", { exact: true })
    .fill("ReplacementBrowser!2468");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A clear view of your school." }),
  ).toBeVisible();
  await page.goto(
    baseURL +
      "/#reset=" +
      encodeURIComponent(token) +
      "&email=" +
      encodeURIComponent(email),
  );
  await page
    .getByLabel("New password", { exact: true })
    .fill("ReplacementBrowser!2468");
  await page.getByLabel("Confirm new password").fill("ReplacementBrowser!2468");
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "invalid, expired or already used",
  );
  await page.getByRole("link", { name: "Request a new recovery link" }).click();
  await expect(
    page.getByRole("heading", { name: "Forgot your password?" }),
  ).toBeVisible();
});
