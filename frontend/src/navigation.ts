// URLs select a workspace view; they never grant tenant or role access.
export const workspacePages = {
  Overview: "overview",
  Branches: "branches",
  "People & access": "people",
  Modules: "modules",
  "Activity log": "activity",
  Settings: "settings",
  "Account security": "security",
} as const;
export type Page = keyof typeof workspacePages;
export interface WorkspaceLocation {
  tenantId: string;
  page: Page;
}
export function workspacePath(tenantId: string, page: Page): string {
  return `/workspace/${tenantId}/${workspacePages[page]}`;
}
export function readWorkspacePath(path: string): WorkspaceLocation | null {
  const match =
    /^\/workspace\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([a-z]+)\/?$/i.exec(
      path,
    );
  if (!match) return null;
  const page = (Object.entries(workspacePages) as [Page, string][]).find(
    ([, slug]) => slug === match[2],
  )?.[0];
  return page ? { tenantId: match[1].toLowerCase(), page } : null;
}
export function canOpenPage(role: string, page: Page): boolean {
  return (
    ["OrganizationAdmin", "BranchAdmin", "Viewer"].includes(role) &&
    (page !== "People & access" || role !== "Viewer")
  );
}
