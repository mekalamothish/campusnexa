# Scoped history pagination — P01-M4a

Invitation history and workspace Activity log now support older records beyond the former 100-row cap. This is a local operational milestone, not production load certification.

## In the application

Open **People & access → Invitation history** or **Activity log**. Each screen displays up to 25 records, newest first. **Older** loads the next page; **Newer** returns through the pages already visited. **Refresh invitations / Refresh activity** starts again at the newest page. Invitation creation, revocation and delivery replacement also refresh to the first page.

Buttons are disabled while the page is loading or when no corresponding page exists. A failed page request keeps the last successful page and its position. Invalid/expired cursor errors ask you to refresh. Navigating away discards that component's page state, and a late response cannot update its replacement. No cursor or history data is stored in localStorage/sessionStorage. Mobile history uses stacked labelled rows with wrapping for long subjects/addresses.

## API contract

The two existing GET endpoints now return an envelope instead of a bare array:

```text
GET /api/tenants/{tenantId}/invitations?pageSize=25
GET /api/tenants/{tenantId}/audit?pageSize=25&cursor={URL-encoded-nextCursor}

{
  "items": [...],
  "nextCursor": "opaque value or null",
  "startCursor": "opaque first-page position",
  "pageSize": 25,
  "snapshotAt": "UTC timestamp"
}
```

`pageSize` defaults to 25 and must be an integer from 1 to 100. Malformed, duplicate, empty or out-of-range supported parameters return 400; the same page size must accompany a cursor. Use `nextCursor` for older rows and `startCursor` for the first page with the same cutoff. A null `nextCursor` means the traversal is exhausted. There is no offset/page-number query or total-count query. UI page numbers describe the visited cursor trail, not a randomly addressable page index. Existing row fields and mutation responses are unchanged. This is an intentional local API contract change; Angular and the affected integration tests were updated together.

Every request independently validates authentication, active organization/membership, platform entitlement and current role/branch scope. Organization administrators alone can read invitations. Activity remains restricted to the permitted school/branch. A cursor is not an access token: it cannot grant permission and never bypasses EF filters. Cross-school routes still return 404; disallowed invitation roles return 403.

ASP.NET Data Protection protects cursor contents and binds each cursor to the history kind, tenant, authenticated user, role, branch grant and page size. Cursors expire one hour after the traversal starts; loading another page does not extend that deadline. Altered cursors, changed scope, another user's/resource's cursor, missing keys and expiry fail closed with 400 after ordinary authorization succeeds. The existing application key ring is required across API replicas/restarts. Production key protection remains outstanding.

## Ordering and consistency

Invitations sort by `(CreatedAt DESC, Id DESC)`; activity sorts by `(OccurredAt DESC, Id DESC)`. The UUID tie-breaker uses PostgreSQL ordering, so equal timestamps do not cause duplicate/skipped rows. Queries use the provider's tuple comparison through LINQ, retain tenant/branch filters, and fetch only `pageSize + 1` projected rows. They never read invitation hashes or mail payloads. See [Npgsql row-value comparison support](https://www.npgsql.org/efcore/mapping/translations.html#row-value-comparisons).

The first request fixes a creation/event-time cutoff; rows timestamped after it are excluded until refresh. **This is not a database snapshot or an export guarantee.** Invitation acceptance/revocation and email-delivery state remain live on each fetch. Transactions committing later with older timestamps, backdated inserts or administrative timestamp changes can alter traversal results. The application does not offer those timestamp mutations. No long-lived database transaction is held between pages.

Migration `20261005193637_HistoryPagination` adds ordered tenant/invitation and tenant/activity indexes and extends the branch/activity index with timestamp and ID. The old narrower branch index is replaced by its covering prefix; no records, keys or columns are deleted. Back up the database and key ring before upgrading, then use `docker compose up --build -d`. Index creation uses the development migration transaction; a large production database needs a separately reviewed online-index rollout.

## Verification and limits

Run `tests/history-pagination.integration.test.mjs` using the fixture instructions in README. It inserts uniquely named revoked historical invitations and audit fixtures in both development schools, with identical microsecond timestamps, then checks exact traversal against PostgreSQL ordering. It briefly changes/restores test membership scope and platform activation to verify each page rechecks authority. Never run fixture tests against real school data.

The browser suite includes real HTTP-backed Older/Newer/Refresh flows and a separately labelled mocked failure/stale-response test. Isolated .NET checks exercise cursor expiry, purpose/user/scope binding and missing-key failure with throwaway keys, not application keys. Results are recorded in VERIFICATION.md.

Branch/member directories remain capped at 200; private account security history remains capped at 100. These endpoints, search/filtering, retention, exports, production observability and agreed load targets are separate follow-up work. No unlimited-scale, point-in-time export or production readiness claim is made.
