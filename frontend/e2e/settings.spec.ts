import { test, expect, Page } from "@playwright/test";
import { resolve } from "node:path";

const tenant = "11111111-1111-1111-1111-111111111111";
const path = `/api/tenants/${tenant}`;
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email address").fill("admin@campusnexa.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env["ADMIN_PASSWORD"]!);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A clear view of your school." }),
  ).toBeVisible();
}
async function settings(page: Page) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings" })
    .click();
  await expect(page.getByLabel("Academic year label")).toBeVisible();
  await expect(page.locator("main[aria-busy]")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function restore(page: Page, endpoint: string, original: object) {
  const latest = await (await page.request.get(endpoint)).json();
  const token = (await page.context().cookies()).find(
    (c) => c.name === "XSRF-TOKEN",
  )!.value;
  const response = await page.request.put(endpoint, {
    headers: { "X-XSRF-TOKEN": decodeURIComponent(token) },
    data: { ...original, version: latest.version },
  });
  expect(response.status()).toBe(200);
}
test("two editors cannot silently overwrite organization preferences; failed reload preserves draft", async ({
  page,
  context,
}) => {
  await login(page);
  const original = await (await page.request.get(path + "/settings")).json();
  const second = await context.newPage();
  try {
    await settings(page);
    await second.goto("/");
    await settings(second);
    await page.getByLabel("Academic year label").fill("Saved by first editor");
    await second.getByLabel("Academic year label").fill("My unsaved draft");
    await page
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Organization preferences saved",
    );
    await second
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await expect(second.getByRole("alert")).toContainText(
      "changed since you opened",
    );
    await expect(second.getByLabel("Academic year label")).toHaveValue(
      "My unsaved draft",
    );
    await expect(
      second.getByRole("button", { name: "Save preferences", exact: true }),
    ).toBeDisabled();
    expect(
      (await (await page.request.get(path + "/settings")).json())
        .academicYearLabel,
    ).toBe("Saved by first editor");
    // Only this failure is simulated; the conflicting writes above use real PostgreSQL.
    await second.route(
      "**/api/tenants/*/settings",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: "{}",
        }),
      { times: 1 },
    );
    const reload = second.getByRole("button", {
      name: "Discard my edits and reload organization preferences",
    });
    await reload.click();
    await expect(second.getByRole("alert")).toContainText(
      "service is unavailable",
    );
    await expect(second.getByLabel("Academic year label")).toHaveValue(
      "My unsaved draft",
    );
    await expect(reload).toBeEnabled();
    await expect(
      second.getByRole("button", { name: "Try again", exact: true }),
    ).toHaveCount(0);
    await second.setViewportSize({ width: 390, height: 844 });
    expect(
      await second.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await second.screenshot({
      path: resolve("../.runtime/screenshots/settings-conflict-mobile.png"),
      fullPage: true,
    });
    await reload.click();
    await expect(second.getByLabel("Academic year label")).toHaveValue(
      "Saved by first editor",
    );
    await second.getByLabel("Academic year label").fill("Reviewed second edit");
    await second
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await expect(second.getByRole("status")).toContainText(
      "Organization preferences saved",
    );
  } finally {
    await restore(page, path + "/settings", original);
    await second.close();
  }
});

test("branch conflict reload is explicit and preserves a separate organization draft", async ({
  page,
  context,
}) => {
  await login(page);
  const branches = await (await page.request.get(path + "/branches")).json();
  const main = branches.find((b: { code: string }) => b.code === "MAIN");
  const endpoint = path + `/branches/${main.id}/settings`;
  const original = {
    timeZone: main.timeZoneOverride,
    locale: main.localeOverride,
    currency: main.currencyOverride,
  };
  const second = await context.newPage();
  try {
    await settings(page);
    await second.goto("/");
    await settings(second);
    await page.getByLabel("Branch", { exact: true }).selectOption(main.id);
    await second.getByLabel("Branch", { exact: true }).selectOption(main.id);
    await second
      .getByLabel("Academic year label")
      .fill("Unrelated organization draft");
    await page.getByLabel("Currency override").fill("INR");
    await second.getByLabel("Currency override").fill("EUR");
    await page
      .getByRole("button", { name: "Save branch overrides", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Branch overrides saved",
    );
    await second
      .getByRole("button", { name: "Save branch overrides", exact: true })
      .click();
    await expect(second.getByRole("alert")).toContainText(
      "changed since you opened",
    );
    await expect(second.getByLabel("Currency override")).toHaveValue("EUR");
    await expect(
      second.getByRole("button", {
        name: "Save branch overrides",
        exact: true,
      }),
    ).toBeDisabled();
    await second
      .getByRole("button", {
        name: "Discard my edits and reload branch overrides",
      })
      .click();
    await expect(second.getByLabel("Currency override")).toHaveValue("INR");
    await expect(second.getByLabel("Academic year label")).toHaveValue(
      "Unrelated organization draft",
    );
    await second.getByLabel("Currency override").fill("");
    await second
      .getByRole("button", { name: "Save branch overrides", exact: true })
      .click();
    await expect(second.getByRole("status")).toContainText(
      "Branch overrides saved",
    );
    expect(
      (await (await page.request.get(endpoint)).json()).currencyOverride,
    ).toBeNull();
  } finally {
    await restore(page, endpoint, original);
    await second.close();
  }
});

test("a delayed settings save cannot update a page the user has left", async ({
  page,
}) => {
  await login(page);
  const original = await (await page.request.get(path + "/settings")).json();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const saved = new Promise<void>((resolve) => {
    received = resolve;
  });
  try {
    await settings(page);
    await page.route("**/api/tenants/*/settings", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      const response = await route.fetch();
      received();
      await hold;
      await route.fulfill({ response });
    });
    await page.getByLabel("Academic year label").fill("Delayed reply fixture");
    await page
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await saved;
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "A clear view of your school." }),
    ).toBeVisible();
    release();
    await expect(page.locator("main[aria-busy]")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(
      page.getByText("Organization preferences saved.", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Academic year label")).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await restore(page, path + "/settings", original);
  }
});
