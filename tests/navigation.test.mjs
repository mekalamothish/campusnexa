import { test } from "node:test";
import assert from "node:assert/strict";
import {
  workspacePages,
  workspacePath,
  readWorkspacePath,
  canOpenPage,
} from "../frontend/src/navigation.ts";
const tenant = "11111111-1111-1111-1111-111111111111";
test("all seven workspace pages have stable round-trip URLs", () => {
  assert.equal(Object.keys(workspacePages).length, 7);
  for (const page of Object.keys(workspacePages))
    assert.deepEqual(readWorkspacePath(workspacePath(tenant, page)), {
      tenantId: tenant,
      page,
    });
});
test("malformed, external and unknown page paths are not navigation targets", () => {
  for (const path of [
    "/",
    "/workspace/not-a-tenant/settings",
    "/workspace/" + tenant + "/admin",
    "//attacker.test/",
    "https://attacker.test/",
    "/workspace/" + tenant + "/settings/extra",
    "/workspace/" + tenant + "/settings?role=admin",
    "/workspace/%2e%2e/settings",
  ])
    assert.equal(readWorkspacePath(path), null, path);
});
test("viewer cannot open the member directory and unknown roles have no pages", () => {
  assert.equal(canOpenPage("Viewer", "People & access"), false);
  assert.equal(canOpenPage("BranchAdmin", "People & access"), true);
  assert.equal(canOpenPage("OrganizationAdmin", "People & access"), true);
  for (const page of Object.keys(workspacePages))
    assert.equal(canOpenPage("InventedAdmin", page), false);
});
test("path normalization retains the validated route only", () => {
  assert.deepEqual(
    readWorkspacePath(
      "/workspace/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/settings/",
    ),
    {
      tenantId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      page: "Settings",
    },
  );
});
