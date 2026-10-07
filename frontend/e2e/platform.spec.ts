import { test, expect, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const screenshots = resolve("../.runtime/screenshots");
mkdirSync(screenshots, { recursive: true });
if (!process.env["ADMIN_PASSWORD"])
  throw new Error("Load the root .env before running browser tests.");
async function login(page: Page, email = "admin@campusnexa.test") {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env["ADMIN_PASSWORD"]!);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A clear view of your school." }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
}
async function nav(page: Page, name: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: false })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.locator("main[aria-busy]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}

test("administrator completes all implemented workspace flows", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByLabel("Email address")).toBeVisible();
  await page.screenshot({
    path: resolve(screenshots, "login-desktop.png"),
    fullPage: true,
  });
  await login(page);
  await expect(page.locator(".hero-panel")).toHaveCSS(
    "background-color",
    "rgb(32, 77, 67)",
  );
  await page.screenshot({
    path: resolve(screenshots, "overview-desktop.png"),
    fullPage: true,
  });
  await nav(page, "Branches");
  const code = `B${Date.now().toString(36).toUpperCase()}`;
  await page
    .getByLabel("Branch name", { exact: true })
    .fill(`Browser verified ${code}`);
  await page.getByLabel("Branch code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByRole("status")).toContainText("Branch created");
  await expect(
    page.getByRole("heading", { name: `Browser verified ${code}` }),
  ).toBeVisible();
  await nav(page, "People & access");
  await expect(
    page.getByRole("cell", { name: "admin@campusnexa.test", exact: false }),
  ).toBeVisible();
  await nav(page, "Modules");
  await expect(
    page.getByText("Not implemented · future delivery phase"),
  ).toHaveCount(5);
  await nav(page, "Settings");
  const year = page.getByLabel("Academic year label"),
    original = await year.inputValue();
  try {
    await year.fill("UI verified");
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Organization preferences saved",
    );
    await page.reload();
    await nav(page, "Settings");
    await expect(year).toHaveValue("UI verified");
  } finally {
    await year.fill(original);
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Organization preferences saved",
    );
  }
  await page.screenshot({
    path: resolve(screenshots, "settings-desktop.png"),
    fullPage: true,
  });
  await nav(page, "Activity log");
  await expect(
    page.getByRole("cell", { name: `Browser verified ${code}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Organization Admin Sign out" })
    .click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  expect(errors).toEqual([]);
});

test("viewer mobile layout, permissions and logout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "viewer@campusnexa.test");
  await expect(
    page
      .getByRole("navigation")
      .getByRole("button", { name: "People & access" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: resolve(screenshots, "overview-mobile.png"),
    fullPage: true,
  });
  await nav(page, "Branches");
  await expect(
    page.getByRole("heading", { name: "Main Campus", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Create branch" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "North Campus", exact: true }),
  ).toHaveCount(0);
  await nav(page, "Settings");
  await expect(page.getByLabel("Display name")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save preferences" }),
  ).toHaveCount(0);
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("wrong password gives a generic recoverable error", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("unknown@campusnexa.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("ThisIsNotAnAccount!");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "check your email and password",
  );
  await expect(
    page.getByRole("button", { name: "Sign in to workspace" }),
  ).toBeEnabled();
});
