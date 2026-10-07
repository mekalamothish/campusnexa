import { test, expect, Page } from "@playwright/test";
const tenant = "11111111-1111-1111-1111-111111111111";
const beta = "22222222-2222-2222-2222-222222222222";
async function signIn(page: Page, email: string) {
  await page.getByLabel("Email address").fill(email);
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env["ADMIN_PASSWORD"]!);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
}
test("a bookmarked page survives sign-in, reload and browser Back/Forward", async ({
  page,
}) => {
  await page.goto(`/workspace/${tenant}/settings`);
  await signIn(page, "admin@campusnexa.test");
  await expect(page.getByLabel("Academic year label")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/workspace/${tenant}/settings$`));
  await expect(page).toHaveTitle("Settings · CampusNexa");
  await page.reload();
  await expect(page.getByLabel("Academic year label")).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Modules" })
    .click();
  await expect(page).toHaveURL(/\/modules$/);
  await page.goBack();
  await expect(page.getByLabel("Academic year label")).toBeVisible();
  await page.goForward();
  await expect(
    page.getByRole("heading", { name: "Modules", exact: true }),
  ).toBeVisible();
});
test("unauthorized tenant and page URLs cannot widen a viewer's access", async ({
  page,
}) => {
  const scopedRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/tenants/")) scopedRequests.push(r.url());
  });
  await page.goto(`/workspace/${beta}/people`);
  await signIn(page, "viewer@campusnexa.test");
  await expect(page.getByRole("alert")).toContainText(
    "unavailable for your account",
  );
  await expect(page).toHaveURL(new RegExp(`/workspace/${tenant}/overview$`));
  expect(scopedRequests.some((p) => p.includes(beta))).toBe(false);
  await page.goto(`/workspace/${tenant}/people`);
  await expect(page.getByRole("alert")).toContainText(
    "unavailable for your account",
  );
  expect(scopedRequests.some((p) => p.endsWith("/members"))).toBe(false);
  await page.goto("/workspace/not-a-tenant/settings");
  await expect(page).toHaveURL(new RegExp(`/workspace/${tenant}/overview$`));
  await page.getByRole("button", { name: "Viewer Sign out" }).click();
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});
