import { test, expect, Page } from "@playwright/test";
import { resolve } from "node:path";

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

test("real invitation and activity history: older, newer, refresh and mobile layout", async ({
  page,
}) => {
  await login(page);
  // Seed enough fictional records for a fresh CI database without relying on prior suites.
  const tenant = "11111111-1111-1111-1111-111111111111",
    suffix = Date.now().toString(36);
  const headers = {
    "X-XSRF-TOKEN": decodeURIComponent(
      (await page.context().cookies()).find((c) => c.name === "XSRF-TOKEN")!
        .value,
    ),
  };
  const branches = await (
    await page.request.get(`/api/tenants/${tenant}/branches`)
  ).json();
  const branchId = branches.find((b: { code: string }) => b.code === "MAIN").id;
  for (let n = 0; n < 26; n++)
    expect(
      (
        await page.request.post(`/api/tenants/${tenant}/invitations`, {
          headers,
          data: {
            email: `pages-ui-${suffix}-${n}@campusnexa.test`,
            role: "Viewer",
            branchId,
          },
        })
      ).status(),
    ).toBe(201);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "People & access" })
    .click();
  const invitations = page.locator("invitation-manager"),
    nav = invitations.getByRole("navigation", {
      name: "invitations pagination",
    });
  await expect(invitations.locator("tbody tr")).toHaveCount(25);
  const newestEmail = await invitations
    .locator("tbody tr")
    .first()
    .locator("td")
    .first()
    .textContent();
  await expect(
    nav.getByRole("button", { name: "Newer invitations" }),
  ).toBeDisabled();
  await nav.getByRole("button", { name: "Older invitations" }).click();
  await expect(nav).toContainText("Page 2");
  await expect(
    invitations.locator("tbody tr").first().locator("td").first(),
  ).not.toHaveText(newestEmail!);
  await nav.getByRole("button", { name: "Newer invitations" }).click();
  await expect(nav).toContainText("Page 1");
  await expect(
    invitations.locator("tbody tr").first().locator("td").first(),
  ).toHaveText(newestEmail!);
  await nav.getByRole("button", { name: "Older invitations" }).click();
  await expect(nav).toContainText("Page 2");
  await invitations
    .getByRole("button", { name: "Refresh invitations" })
    .click();
  await expect(nav).toContainText("Page 1");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Activity log", exact: true })
    .click();
  const activity = page.locator("activity-history"),
    activityNav = activity.getByRole("navigation", {
      name: "activity pagination",
    });
  await expect(activity.locator("tbody tr")).toHaveCount(25);
  const newestSubject = await activity
    .locator("tbody tr")
    .first()
    .locator("td")
    .nth(1)
    .textContent();
  await activityNav.getByRole("button", { name: "Older activity" }).click();
  await expect(activityNav).toContainText("Page 2");
  await activityNav.getByRole("button", { name: "Newer activity" }).click();
  await expect(activityNav).toContainText("Page 1");
  await expect(
    activity.locator("tbody tr").first().locator("td").nth(1),
  ).toHaveText(newestSubject!);
  await activityNav.screenshot({
    path: resolve("../.runtime/screenshots/history-pagination-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await activityNav.getByRole("button", { name: "Older activity" }).click();
  await expect(activityNav).toContainText("Page 2");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await activity
    .locator("tbody tr")
    .first()
    .screenshot({
      path: resolve("../.runtime/screenshots/activity-row-mobile.png"),
    });
  const overflow = await activity.locator(".table-scroll").evaluate((el) => ({
    width: el.clientWidth,
    scroll: el.scrollWidth,
    children: [...el.querySelectorAll("*")]
      .filter(
        (x) =>
          x.getBoundingClientRect().right >
          el.getBoundingClientRect().right + 1,
      )
      .slice(0, 8)
      .map((x) => ({
        tag: x.tagName,
        classes: x.className,
        width: x.getBoundingClientRect().width,
        text: x.textContent?.slice(0, 80),
      })),
  }));
  expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(
    overflow.width,
  );
  expect(
    await activity
      .locator(".table-scroll")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await activityNav.screenshot({
    path: resolve("../.runtime/screenshots/history-pagination-mobile.png"),
  });
  await activity
    .locator("tbody tr")
    .first()
    .screenshot({
      path: resolve("../.runtime/screenshots/activity-row-mobile.png"),
    });
  await activity.getByRole("button", { name: "Refresh activity" }).click();
  await expect(activityNav).toContainText("Page 1");
});

test("history retains its page on errors, disables busy/end controls and ignores abandoned responses (mocked pages)", async ({
  page,
}) => {
  await login(page);
  let fail = true,
    release: () => void = () => {},
    delayed = false;
  const rows = (name: string) => [
    {
      id: name,
      action: "pagination.fixture",
      subject: name,
      occurredAt: new Date().toISOString(),
    },
  ];
  const envelope = (name: string, next: string | null) => ({
    items: rows(name),
    nextCursor: next,
    startCursor: "start",
    pageSize: 25,
    snapshotAt: new Date().toISOString(),
  });
  await page.route("**/api/tenants/*/audit?*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor === "older" && fail) {
      fail = false;
      await route.fulfill({
        status: 400,
        json: {
          message:
            "Invalid or expired history cursor/page size. Refresh to start from the latest records.",
        },
      });
      return;
    }
    if (cursor === "older" && delayed) {
      await new Promise<void>((r) => (release = r));
      await route.fulfill({ json: envelope("abandoned-result", null) });
      return;
    }
    await route.fulfill({
      json: envelope(
        cursor === "older" ? "older-row" : "newest-row",
        cursor === "older" ? null : "older",
      ),
    });
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Activity log", exact: true })
    .click();
  const history = page.locator("activity-history"),
    nav = history.getByRole("navigation", { name: "activity pagination" });
  await expect(
    history.getByRole("cell", { name: "newest-row", exact: true }),
  ).toBeVisible();
  await nav.getByRole("button", { name: "Older activity" }).click();
  await expect(history.getByRole("alert")).toContainText(
    "expired history cursor",
  );
  await expect(nav).toContainText("Page 1");
  await expect(
    history.getByRole("cell", { name: "newest-row", exact: true }),
  ).toBeVisible();
  await nav.getByRole("button", { name: "Older activity" }).click();
  await expect(nav).toContainText("Page 2");
  await expect(
    nav.getByRole("button", { name: "Older activity" }),
  ).toBeDisabled();
  await expect(history.getByRole("alert")).toHaveCount(0);
  await history.getByRole("button", { name: "Refresh activity" }).click();
  await expect(nav).toContainText("Page 1");
  delayed = true;
  await nav.getByRole("button", { name: "Older activity" }).click();
  await expect(nav).toContainText("Loading");
  await expect(
    nav.getByRole("button", { name: "Older activity" }),
  ).toBeDisabled();
  await expect(
    nav.getByRole("button", { name: "Newer activity" }),
  ).toBeDisabled();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  release();
  delayed = false;
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Activity log", exact: true })
    .click();
  await expect(
    history.getByRole("cell", { name: "newest-row", exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole("cell", { name: "abandoned-result", exact: true }),
  ).toHaveCount(0);
  await expect(nav).toContainText("Page 1");
});
