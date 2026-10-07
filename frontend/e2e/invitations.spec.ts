import { test, expect } from "@playwright/test";
import { waitForMail } from "./mail-helper";
import { resolve } from "node:path";

test("admin invitation, email link, new account and restricted workspace", async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("admin@campusnexa.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env["ADMIN_PASSWORD"]!);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A clear view of your school." }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "People & access" })
    .click();
  const email = `browser-invite-${Date.now().toString(36)}@campusnexa.test`;
  await page.getByLabel("Invite email").fill(email);
  await page.getByLabel("Invite role").selectOption("Viewer");
  await page
    .getByLabel("Assigned branch")
    .selectOption({ label: "Main Campus" });
  await page
    .getByRole("button", { name: "Send invitation", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Invitation queued");
  const inbox = process.env["MAIL_URL"] ?? "http://127.0.0.1:8025";
  const mail = await waitForMail(
    request,
    inbox,
    email,
    "Your CampusNexa invitation",
  );
  const token = mail.Text.match(/#invite=([A-F0-9]{64})/)[1];
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "Refresh invitations" }).click();
      return page
        .getByRole("row")
        .filter({ has: page.getByRole("cell", { name: email, exact: true }) })
        .textContent();
    })
    .toContain("Sent to test inbox");
  await page.screenshot({
    path: resolve("../.runtime/screenshots/invitations-desktop.png"),
    fullPage: true,
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const join = await context.newPage();
  await join.goto(baseURL + "/#invite=" + token);
  await expect(
    join.getByRole("heading", { name: "You're invited." }),
  ).toBeVisible();
  await expect(
    join.getByRole("heading", { name: "Greenfield Education" }),
  ).toBeVisible();
  expect(join.url()).not.toContain(token);
  await join.screenshot({
    path: resolve("../.runtime/screenshots/accept-invitation-mobile.png"),
    fullPage: true,
  });
  await join.getByLabel("Your full name").fill("Browser Invited Viewer");
  await join.getByLabel("Create password").fill("BrowserInvitePassword!345");
  await join.getByRole("button", { name: "Create account and join" }).click();
  await expect(join.getByRole("status")).toContainText("Invitation accepted");
  await join.getByRole("link", { name: "Continue to sign in" }).click();
  await join.getByLabel("Email address").fill(email);
  await join
    .getByLabel("Password", { exact: true })
    .fill("BrowserInvitePassword!345");
  await join.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    join.getByRole("heading", { name: "A clear view of your school." }),
  ).toBeVisible();
  await expect(
    join
      .getByRole("navigation")
      .getByRole("button", { name: "People & access" }),
  ).toHaveCount(0);
  await join.goto(baseURL + "/#invite=" + token);
  await expect(join.getByRole("alert")).toContainText(
    "invalid, expired or no longer available",
  );
  await context.close();
  await page.getByRole("button", { name: "Refresh invitations" }).click();
  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: email, exact: true }) }),
  ).toContainText("Accepted");
});

// UI-only state/confirmation coverage. The real PostgreSQL retry/authorization flow
// is exercised by tests/invitation-delivery.integration.test.mjs, not mocked there.
test("delivery states and explicit retry confirmation on mobile (mocked delivery responses)", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("admin@campusnexa.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill(process.env["ADMIN_PASSWORD"]!);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A clear view of your school." }),
  ).toBeVisible();
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const failed = {
    id: "10000000-0000-0000-0000-000000000001",
    email: "failed-ui@campusnexa.test",
    role: "Viewer",
    branchId: null,
    expiresAt,
    acceptedAt: null,
    revokedAt: null as string | null,
    delivery: {
      status: "Dead",
      attempts: 5,
      nextAttemptAt: null as string | null,
      completedAt: new Date().toISOString() as string | null,
    },
  };
  const rows: (Omit<typeof failed, "delivery"> & {
    delivery: typeof failed.delivery | null;
  })[] = [
    failed,
    ...["Pending", "Sent", "Cancelled", "Expired"].map((status, index) => ({
      ...failed,
      id: `ui-${index}`,
      email: `${status.toLowerCase()}-ui@campusnexa.test`,
      delivery: {
        ...failed.delivery,
        status,
        attempts: status === "Pending" || status === "Sent" ? 1 : 0,
        nextAttemptAt: status === "Pending" ? expiresAt : null,
        completedAt: status === "Pending" ? null : failed.delivery.completedAt,
      },
    })),
    {
      ...failed,
      id: "legacy",
      email: "legacy-ui@campusnexa.test",
      delivery: null,
    },
    {
      ...failed,
      id: "expired-dead",
      email: "old-ui@campusnexa.test",
      expiresAt: new Date(Date.now() - 3600000).toISOString(),
    },
  ];
  let tries = 0;
  await page.route("**/api/tenants/*/invitations?*", (route) =>
    route.fulfill({
      json: {
        items: rows,
        nextCursor: null,
        startCursor: "ui-start",
        pageSize: 25,
        snapshotAt: new Date().toISOString(),
      },
    }),
  );
  await page.route(
    "**/api/tenants/*/invitations/*/retry-delivery",
    async (route) => {
      tries++;
      if (tries === 1) {
        await route.fulfill({
          status: 409,
          json: { message: "This record changed. Refresh and try again." },
        });
        return;
      }
      failed.revokedAt = new Date().toISOString();
      rows.unshift({
        ...failed,
        id: "replacement",
        revokedAt: null,
        delivery: {
          status: "Pending",
          attempts: 0,
          nextAttemptAt: new Date().toISOString(),
          completedAt: null,
        },
      });
      await route.fulfill({ status: 201, json: { id: "replacement" } });
    },
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "People & access" })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const label of [
    "Failed",
    "Retry scheduled",
    "Sent to test inbox",
    "Cancelled",
    "Expired before delivery",
    "Not tracked",
  ])
    await expect(
      page.getByRole("cell", { name: label, exact: false }).first(),
    ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const history = page.locator("invitation-manager section").last();
  expect(
    await history
      .locator(".table-scroll")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: /^Retry delivery for/ }),
  ).toHaveCount(1);
  await page
    .getByRole("button", {
      name: "Retry delivery for failed-ui@campusnexa.test",
      exact: true,
    })
    .click();
  const confirmation = page.getByRole("region", {
    name: "Confirm delivery retry",
  });
  await expect(confirmation).toContainText("same role, branch and expiry");
  await expect(confirmation).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await confirmation.screenshot({
    path: resolve(
      "../.runtime/screenshots/invitation-retry-confirmation-mobile.png",
    ),
  });
  await page.getByRole("button", { name: "Cancel retry", exact: true }).click();
  expect(tries).toBe(0);
  await expect(confirmation).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Retry delivery for failed-ui@campusnexa.test",
      exact: true,
    }),
  ).toBeFocused();
  await page
    .getByRole("button", {
      name: "Retry delivery for failed-ui@campusnexa.test",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Confirm retry", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("This record changed");
  await page.getByRole("button", { name: "Refresh invitations" }).click();
  await expect(confirmation).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Retry delivery for failed-ui@campusnexa.test",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Confirm retry", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "original expiry is unchanged",
  );
  await expect(
    page.getByRole("button", { name: /^Retry delivery for/ }),
  ).toHaveCount(0);
  expect(tries).toBe(2);
  await expect(
    page.getByRole("cell", { name: "Queued", exact: false }).first(),
  ).toBeVisible();
  await page
    .locator("invitation-manager section")
    .last()
    .screenshot({
      path: resolve("../.runtime/screenshots/invitation-delivery-mobile.png"),
    });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .locator("invitation-manager section")
    .last()
    .screenshot({
      path: resolve("../.runtime/screenshots/invitation-delivery-desktop.png"),
    });
});
