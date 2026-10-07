# Settings edits and workspace navigation

Organization defaults and branch overrides use optimistic concurrency. A save cannot silently replace changes committed after the editor loaded its values.

## API contract

- Organization GET and successful PUT return a nonempty UUID `version`.
- Branch list/detail and effective-settings GET return the branch `version`. Effective-settings GET also returns `defaultsVersion` for the organization defaults used in that response.
- Both settings PUT bodies must include the last version read for that exact resource. Missing/null/empty versions return 428. Malformed JSON/UUID values return 400. A stale or different resource's version returns 409 after authorization.
- Successful organization PUT returns its updated settings. Successful branch-settings PUT now returns **200 and the updated branch**, replacing the earlier 204 contract.
- Every accepted save, even one whose values are unchanged, rotates the version. A replay with the previous version is rejected.
- Current tenant membership, branch scope, role and CSRF checks still apply. A version is not an access token.

Example branch body:

```json
{
  "version": "use-the-version-from-the-branch-read",
  "timeZone": "Asia/Kolkata",
  "locale": "en-IN",
  "currency": "INR"
}
```

The example version is a placeholder, not a valid UUID. Null preference fields remove their override and inherit the current organization setting.

EF includes the original version in the database UPDATE predicate. Versions rotate for tracked Branch/TenantSettings modifications. Simultaneous saves cannot both commit with the same version. The settings change and success audit share SaveChanges' transaction; a conflict does not record a successful change. Infrastructure SQL must explicitly preserve the version contract; bypassing tracked EF writes is not an approved application write path.

Branch versions protect branch overrides independently of organization defaults. An organization edit does not invalidate a branch override editor. Inherited effective values may therefore change when defaults change. The two GET reads are not a repeatable database snapshot.

## Browser behavior

On conflict the draft stays visible and saving that stale form is disabled. Choose **Discard my edits and reload organization preferences** or **Discard my edits and reload branch overrides** to explicitly replace the draft, then review and edit again. There is no automatic retry or force-overwrite action. A failed reload preserves the draft and conflict state. Reloading branch overrides does not discard a separate organization draft.

Page navigation, a full browser reload or changing the selected branch discards that view's draft; there is not yet an unsaved-edit navigation confirmation. Drafts and versions are held in memory, not browser storage. Navigating away ignores late settings responses; this cannot cancel a write that the server already committed.

## Workspace URLs

The seven current screens have URLs of the form `/workspace/{tenantId}/{page}`, with pages `overview`, `branches`, `people`, `modules`, `activity`, `settings` and `security`. The Angular shell uses the browser History API for these view states; it is not yet a lazy-loaded Angular Router module tree.

A bookmark retains its requested page through sign-in and browser reload. Back/Forward restores the corresponding page and validates the selected school against the signed-in account's memberships. Invalid or unavailable routes return to a permitted overview with an explanatory message. Viewer URLs cannot open the member directory. All API calls still perform server authorization; client navigation is not a security boundary. Tenant-bound history/invitation components are recreated when tenant identity changes so their cursors and drafts cannot carry across schools.

Invitation/recovery secrets remain transient fragment inputs and are removed from the address bar. Workspace URLs contain only tenant identifiers and allowlisted page names, never credentials or secrets.

## Audit protection

Migration `20261006041606_SettingsConcurrencyAndAuditGuards` adds a randomly initialized Version column to Settings and Branches without deleting their data, and rejects business-audit UPDATE, DELETE and TRUNCATE using PostgreSQL triggers. Ordinary inserts and transactional rollbacks still work. Database owners/superusers can disable triggers; this is not immutable external storage or an approved retention/erasure process.

Implementation references: [EF Core concurrency](https://learn.microsoft.com/en-us/ef/core/saving/concurrency) and [PostgreSQL 17 CREATE TRIGGER](https://www.postgresql.org/docs/17/sql-createtrigger.html).
