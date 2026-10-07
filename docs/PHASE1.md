# Phase 1 — execution record

Updated: 6 October 2026, Asia/Kolkata. Working product name: CampusNexa; trademark/domain clearance is not performed.

## Scope and source of truth

The owner has requested completion of Phase 1 before Phase 2. The finite original-package gates and external dependencies are tracked in **PHASE1-CHECKLIST.md**; local milestones do not close the full phase. The owner supplied the GitHub repository and authorized the initial push. No staging host is available yet.

The product and phased delivery plan remains the overall scope reference. This file records implementation facts and supersedes its earlier undecided database choice and pre-implementation status. User decisions: PostgreSQL, Docker, Angular, ASP.NET Core, multi-school/multi-branch support and Tailwind CSS. Mobile clients are later-phase work.

The **first platform-foundation milestone (P01-M1)**, **local onboarding/invitation slice (P01-M2a)**, **local password recovery slice (P01-M2b)**, **optional authenticator MFA slice (P01-M2c)** and **encrypted authenticator storage/private security history slice (P01-M2d)** are implemented locally. Verification evidence is recorded in VERIFICATION.md. Full P01-M2 remains open. This does not mean all P01 task packages or the complete SRS have been accepted. Do not begin student/finance workflows while their business rules remain unresolved.

## Implemented baseline

**P01-M2e** adds trusted-local-operator recovery of expired initial administrator invitations. It is limited to unfinished onboarding; production operator authorization remains open.

**P01-M3a** adds the encrypted PostgreSQL mail outbox and separate local delivery worker, including bounded retries and stale-message suppression. See MAIL.md for delivery semantics and operator commands.

**P01-M3b** adds organization-admin invitation delivery metadata and confirmed retry of terminal failed delivery. Retry atomically replaces the invitation, preserves email/role/branch/original expiry, revokes the old link and records linked audit. No schema change or generic mail-administration access is introduced.

**P01-M4a** adds cursor pagination for invitation and workspace activity history, with protected scope-bound positions, indexed timestamp/UUID ordering and responsive Older/Newer/Refresh controls. See HISTORY.md for the changed GET response envelopes and consistency limits.

**P01-M4b** adds versioned organization/branch settings, conflict recovery without silent draft replacement, database business-audit guards and validated workspace URLs with Back/Forward. See SETTINGS.md for contracts and limits. Source publication is now authorized; staging, email-provider and policy dependencies remain open.

| Package | This milestone | Not yet complete |
| --- | --- | --- |
| P01-T01 — delivery foundation | Project structure, pinned npm/NuGet locks, Dockerfiles, Compose, CI definition, real database/browser tests | Remote repository, protected branches, staging/production pipelines, dependency automation and image digest policy |
| P01-T02 — tenant/branch boundaries | Validated membership scope, composite tenant keys/FKs, branch restrictions, two-tenant fixtures, negative API tests; local server-command onboarding and expired first-admin invitation recovery | Production operator onboarding/offboarding, multi-branch grants per member, database RLS evaluation, tenant export/erasure and dedicated-database tiers |
| P01-T03 — identity/permissions | ASP.NET Identity, hashed passwords, cookies, CSRF, lockout, request-time membership/active-user checks, session revocation; three fixed roles; local invitations/password recovery; optional TOTP MFA/recovery codes; encrypted authenticator secrets and durable private security history | Production recovery/email delivery/ownership verification, mandatory MFA policies, protected master-key storage, support factor recovery, SSO/passkeys, custom permission editor, support access, external audit/monitoring and security notifications |
| P01-T04 — settings/entitlements | Organization preferences, branch overrides, inheritance, versioned conflict-safe saves, server-side platform/module gates | Agreed branding, dated academic periods and numbering settings; controlled feature rollout. Paid billing is later-phase work. |
| P01-T05 — shared services | Transactional business-change audit, validation, backup/isolated restore, encrypted transactional email outbox and local worker retries | Object storage, upload scanning, production notification providers, other durable jobs, import/export jobs, idempotency framework |
| P01-T06 — shell/operations | Tailwind responsive shell, member directory, loading/error states, seven workspace page URLs with Back/Forward, liveness/readiness and request trace ID | Remaining list caps, translation, OpenAPI/mobile authentication contracts, telemetry dashboards, alerts, load testing and accessibility audit |

## Architecture decisions

1. **Modular monolith first.** One ASP.NET deployment and PostgreSQL database. Future domain modules remain separated by code ownership and explicit service contracts; do not create one service/database per screen. Extract services only when measured scale or team ownership justifies it.
2. **Tenant = customer organization; branch = campus.** A network of schools may be one contracted tenant with branches. Separate customer schools must have separate tenants. Final legal/billing definitions are still a business decision.
3. **Shared schema, explicit tenant keys.** Business rows carry `TenantId`. Branch, membership and audit references use tenant-aware composite keys where applicable. EF query filters plus write guards enforce tenant/branch scope for the implemented entities. Membership lookup is explicitly constrained by authenticated user and tenant. This is application-enforced isolation, not PostgreSQL RLS, and not a guarantee against future unsafe raw SQL.
4. **No client-trusted roles or tenant headers.** Each tenant API validates active membership and organization before installing a request scope. Route IDs identify a requested resource; they do not authorize access. Cross-tenant access returns 404; denied actions within an authorized scope return 403.
5. **Server-owned identity and browser sessions.** No passwords or bearer tokens in browser storage. HttpOnly SameSite=Strict session cookies, antiforgery header for mutations including login, eight-hour non-sliding sessions, and security stamp validation on every request. Five failed known-account attempts trigger a ten-minute lockout. Login rate limit is 20 requests/minute per observed IP. Behind the local proxy that can aggregate clients; trusted forwarded-header/distributed limiting is a production prerequisite.
6. **Mobile-ready direction, not mobile auth implementation.** Business APIs are separate from Angular. A later mobile phase needs standards-based authorization/PKCE, push tokens, API versioning and offline policy; do not embed these browser cookies or admin passwords into native apps.
7. **Configuration precedence:** branch override → organization preference. Null branch overrides inherit; clearing a field restores inheritance. Defaults are UTC/en-US/USD fixture values, not a confirmed target market. Academic year is only a label at this stage, not a calendaring implementation.
8. **Tailwind design system.** Tailwind v4 PostCSS compilation, semantic color tokens, responsive utility classes and reusable `@apply` component recipes. Original CampusNexa design; no third-party template assets or Figma content were copied.
9. **Scale needs measurement.** API instances can be stateless except shared session encryption keys; database persistence is external. Horizontal scaling also requires shared key protection, distributed limits/jobs/cache as needed, connection budgets and load benchmarks. Invitation/workspace audit histories now use keyset pagination (25 default, 100 maximum per API page); branches/members remain capped at 200 and private security history at 100. No claim of unlimited scale.
10. **Extension strategy:** evolve through tenant configuration, entitlement-controlled modules, versioned APIs/webhooks and later sandboxed extensions. Arbitrary customer code does not run in the core API. Avoid per-school forks and schema changes without reviewed migrations.
11. **Controlled local onboarding.** A trusted server operator runs `api --onboard` only in Development with local delivery enabled. No browser user gains platform-wide provisioning rights. The command creates one school and an initial invitation transactionally; duplicate slugs are rejected. Production operator identity, authorization and approval policy are unresolved. CLI-originated audit entries have an empty actor GUID because there is no authenticated operator account yet.
12. **Invitation capability boundary.** Only organization admins issue/list/revoke invitations within their tenant. Acceptance uses a cryptographically random 256-bit secret; only its SHA-256 hash is stored in PostgreSQL. The narrowly scoped capability lookup intentionally bypasses tenant filters, checks the hash, expiry, revocation/acceptance, active organization and enabled platform entitlement, then installs the resolved tenant scope. Callers cannot choose the persisted role or branch at acceptance. Existing accounts require matching authenticated identity; their password is never replaced. New identity, membership, acceptance and audit commit together. Concurrency tokens and uniqueness constraints prevent duplicate acceptance. Browser mutations require CSRF; issue/preview/accept are rate limited to 60 requests/minute per authenticated user or observed IP. Raw invitation fragments are removed from the browser address bar after capture and not stored in browser storage.
13. **Local mail with durable queuing.** Mailpit is loopback-only and unauthenticated, with no durable captured-message volume or internet delivery. New-account acceptance sets the Identity email-confirmed flag based on possession of the local link; this is not real-world email ownership verification. M3a commits encrypted mail jobs with domain writes and sends them after commit through a separate worker. One due row is locked using infrastructure-only SQL with SKIP LOCKED; invitation scope is protected by composite keys and worker eligibility checks. SMTP retries are bounded to five attempts. A crash after send but before marking completion can duplicate delivery; exactly-once SMTP is not claimed. Production providers, monitoring and retention controls remain open.
14. **Account-global password recovery.** ASP.NET Identity's Data Protection token provider uses a dedicated recovery purpose and fixed 30-minute lifetime. Successful reset changes password/security stamp; earlier recovery links and sessions fail validation. No automatic sign-in or membership changes occur. Recovery needs an active, email-confirmed account and remains Development/local-mail-only. Lockouts are retained. Generic request acknowledgements follow durable enqueue, not SMTP submission. The encrypted queue payload includes the originating security stamp; invalidated jobs are suppressed. Tokens exist in plaintext only in captured mail and transient server/browser memory, not browser storage, API responses or log messages. Reset fragments are cleared. Password reset and its event commit together; queue insertion and recovery-request event commit together. Exhausted delivery retries record a private failure event.
15. **Recovery abuse controls and limitations.** Both endpoints require CSRF. Requests are limited to 10/minute and reset attempts to 20/minute per observed IP, in-process fixed windows. The proxy aggregates clients; distributed limits, trusted forwarding, per-account throttling and abuse monitoring remain production work. SMTP now runs asynchronously, but account lookup, token generation and queue insertion can still affect response timing. Timing review and password-change notifications remain pending. Browser confirmation is a usability check; password policy and token validation remain server-enforced.
16. **Optional account-wide MFA.** Identity validates authenticator TOTP codes; account self-service never accepts a target user, tenant or role. Setup requires the current password; enabling requires password plus authenticator proof. Replace-codes/disable require password plus an authenticator or unused recovery code. There is no remembered-device bypass, password-only MFA removal, or administrative override. Password reset preserves MFA. Security changes rotate the security stamp and refresh only the current session. Used TOTP hashes are rejected for five minutes to cover the provider's acceptance window; subsequent operations need a fresh code. Mandatory role/tenant enforcement and support recovery are policy decisions, not silently enabled defaults.
17. **MFA challenge and recovery state.** A correct password for an enrolled account issues a five-minute time-limited Data Protection challenge in an HttpOnly SameSite=Strict cookie; Secure is required outside Development. It is not a session cookie and does not authorize workspace access. The challenge carries the account/security-stamp binding and a random nonce; a nonce hash in the account's Identity token store permits only the latest pending login and single consumption. Verification rechecks active/confirmed/MFA-enabled/not-locked status and security stamp. Ten 128-bit random recovery codes are returned once; only SHA-256 hashes are stored. Consumption, factor changes and code replacement use database transactions plus Identity user concurrency checks. Successful verification issues the normal session only after commit. MFA endpoints require CSRF for writes and share a 30/minute per-user-or-observed-IP in-process limiter; failures use Identity's five-attempt/ten-minute lockout.
18. **Account-bound authenticator encryption.** A custom Identity store encrypts authenticator token values with a versioned Data Protection purpose and account-ID binding. Runtime reads reject plaintext/unknown versions and fail closed on decryption errors; there is no fallback to unprotected storage. Operator `--migrate` validates existing ciphertext and upgrades legacy keys in an all-or-nothing conversion transaction using original-value comparisons to detect concurrent changes. Stop the old API first; back up both database and key ring. Schema migration commits separately. Conversion currently loads all keys into memory and needs batching before a large rollout. Data Protection master-key files remain unencrypted by local configuration; database ciphertext is not protection against access to both volumes. Key loss can prevent MFA; never silently reset factors or delete the key volume.
19. **Private account security history.** SecurityEvents is account-global, not tenant-global. Its EF read filter defaults to no account; only the authenticated-user endpoint installs the current user ID. There is no administrator or caller-selected-account read endpoint. Latest 100 events expose only ID, allowlisted action and UTC timestamp. Known-account authentication, MFA/recovery actions, logout/revocation and key upgrades are recorded without free-text payloads or IP/device data. Unknown-account/unattributable requests are not represented. Factor/password changes and events share their database transactions. EF guards plus PostgreSQL update/delete/truncate triggers enforce append-only history for ordinary writes; a database owner can bypass them, so this is not immutable external audit. Retention/erasure and external monitoring are pending policies.
20. **MFA release limits.** Protected master-key storage, security notifications, mandatory rollout, QR enrollment, passkeys, trusted devices and lost-all-factors support are not delivered. Enrollment, ciphertext storage and security history do not make the development Compose setup production-ready.
21. **Invitation delivery isolation and retry.** The queue remains deny-by-default. HTTP invitation handlers use an explicit read-only opt-in whose EF filter additionally requires validated organization-admin scope, matching tenant and Invitation kind. Only safe metadata is projected; account recovery messages and encrypted payloads are not read. Existing-job modification remains worker-only. Retrying a terminal Dead delivery requires an active unaccepted/unrevoked/unexpired invitation, no existing membership, CSRF and the invitation rate limiter. A fresh invitation/secret and encrypted job replace the old link transactionally, without changing recipient/role/branch/deadline; the terminal job is untouched. Linked audit and invitation concurrency tokens protect rollback and duplicate/stale actions. No endpoint raw SQL or filter bypass is introduced. This is a local delivery feature, not production support authority.

## Permission baseline

Bootstrap recovery is a local CLI operation, not a browser permission. `--bootstrap-status` is read-only; `--reissue-bootstrap` requires the exact school slug and expired invitation ID. It preserves recipient/role and requires active school/platform access, zero memberships including inactive ones, an onboarding audit record and consistent bootstrap history. Revocation, replacement, audit and encrypted mail job commit together under serializable isolation. Queue-write failure rolls back all changes; later SMTP failure is retried by the worker. Existing concurrency checks prevent two successful replacements. Commands require Development/local mail; actor IDs remain empty for operator audit records. They cannot change credentials, remove MFA or recover an established administrator. There is no automatic transaction retry.

| Action | Organization admin | Branch admin | Viewer |
| --- | --- | --- | --- |
| Read overview/branches/audit | All own-tenant branches | Assigned branch | Assigned branch |
| Create branch | Yes | No | No |
| Read organization defaults/module status | Yes | Yes | Yes |
| Edit organization defaults | Yes | No | No |
| Edit branch overrides | Any own branch | Assigned branch | No |
| View member directory | Own tenant | Assigned branch | No |
| Issue/list/revoke invitations | Own tenant | No | No |
| Read invitation delivery / retry eligible terminal failure | Own tenant | No | No |
| Revoke own sessions | Yes | Yes | Yes |
| Manage own MFA with required proofs | Yes | Yes | Yes |
| Read own security history (never another account's) | Yes | Yes | Yes |

One membership per tenant/user is supported. Non-organization-admin memberships have one assigned branch. Multi-branch access grants, teacher/parent/student roles and permission composition are not implemented yet. Platform operator/super-admin is intentionally absent, not implicitly equivalent to organization admin.

## Data and API contracts

Identity tables are ASP.NET Identity tables with GUID IDs. Domain tables: Organizations, Memberships, Branches, Settings, Entitlements, Invitations and AuditEvents; SecurityEvents is account-global and MailQueue is an infrastructure table with invitation/account scope and a safe school-admin invitation-metadata projection. Migrations are generated and included as source. Migrations run in a separate one-shot container before API/worker startup; never run destructive migrations without review and backups.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/csrf` | Issue antiforgery cookies/token; refresh after authentication changes |
| `POST /api/auth/login` | Authenticate fixture/known account |
| `GET /api/auth/me` | Own identity and active organization memberships |
| `GET /api/auth/security-events` | Latest 100 own-account security events; school role cannot broaden access |
| `POST /api/auth/logout` | Clear current browser cookie |
| `POST /api/auth/revoke-sessions` | Rotate security stamp; invalidate all user sessions |
| `POST /api/auth/forgot-password` | Generic acknowledgement; local recovery email for eligible account |
| `POST /api/auth/reset-password` | Validate email-bound recovery token and replace password; invalidate prior sessions/links |
| `GET /api/auth/mfa/status` | Own enrollment status and recovery-code count; no secrets |
| `POST /api/auth/mfa/setup` | Password-verified manual authenticator setup key; MFA remains off until proof |
| `POST /api/auth/mfa/enable` | Password + TOTP confirmation; issue recovery codes once |
| `POST /api/auth/mfa/verify` | Complete pending password challenge with TOTP or unused recovery code |
| `POST /api/auth/mfa/recovery-codes` | Password + factor; replace all recovery codes |
| `POST /api/auth/mfa/disable` | Password + factor; disable MFA and invalidate recovery codes/key |
| `GET /api/tenants/{tenantId}/overview` | Real, permission-scoped counters and recent changes |
| `GET/POST /api/tenants/{tenantId}/branches` | Scoped branch list / admin-only creation |
| `GET /api/tenants/{tenantId}/branches/{branchId}` | Scoped branch details |
| `GET/PUT /api/tenants/{tenantId}/settings` | Organization preferences |
| `GET/PUT /api/tenants/{tenantId}/branches/{branchId}/settings` | Effective settings / nullable overrides |
| `GET /api/tenants/{tenantId}/members` | Scoped, read-only directory |
| `GET/POST /api/tenants/{tenantId}/invitations` | Admin-only scoped history with safe delivery metadata / issue invitation |
| `POST /api/tenants/{tenantId}/invitations/{id}/retry-delivery` | Admin-only atomic replacement of an active invitation with terminal failed delivery; original expiry preserved |
| `POST /api/tenants/{tenantId}/invitations/{id}/revoke` | Admin-only pending invitation revocation |
| `POST /api/invitations/preview` | Secret-capability invitation preview, including sign-in requirement |
| `POST /api/invitations/accept` | Single-use account/membership creation; matching sign-in required for existing users |
| `GET /api/tenants/{tenantId}/modules` | Entitlement status |
| `GET /api/tenants/{tenantId}/audit` | Cursor-paginated permitted change events |
| `GET /api/tenants/{tenantId}/academics` | Guard demonstration; 403 disabled, 501 if enabled, never fake academic data |
| `GET /health/live`, `GET /health/ready` | Process liveness and database connectivity |

Tenant management write bodies cannot select the persisted TenantId; it comes from authenticated membership scope. The documented invitation capability is the separate onboarding exception. UTC timestamps are stored in PostgreSQL. Browser audit timestamps currently use the browser timezone. Preference validation checks recognized .NET timezone/culture and a three-uppercase-letter currency format; a complete currency catalogue is not implemented. Invitation lifecycle fields have optimistic concurrency tokens. Organization and branch settings now require a nonempty resource version, return 428 if absent and 409 on conflict, and rotate their version on successful save. Branch settings PUT now returns 200 with the updated branch. Successful changes and their audit commit together; rejected changes do not add a success audit.

Invitation/audit GETs accept `pageSize` (1–100, default 25) and an opaque `cursor`, returning `{ items, nextCursor, startCursor, pageSize, snapshotAt }`. Their former bare-array responses are intentionally superseded. Cursors expire one hour after traversal starts and bind resource, user, tenant, role, branch and page size; every request still revalidates current authorization. Queries retain EF filters and use indexed timestamp/UUID tuple seeks, not OFFSET. The timestamp cutoff excludes normal newer inserts until refresh, but is not a repeatable database snapshot; delivery/lifecycle fields remain live. Index migration contains no row/key/column deletion. Full details and limitations: HISTORY.md.

## Verification and acceptance

Automated integration tests cover real PostgreSQL persistence, cookie flags, unauthenticated access, login/mutation CSRF, cross-tenant reads/writes, forged headers, branch restrictions, viewer restrictions, validation/duplicates, settings inheritance/restoration, audit scope, module gates, logout and other-session revocation.

Browser checks cover production-built Angular/Tailwind assets, login errors, all six workspace screens, creation, saved preference persistence across reload, role-limited mobile navigation, viewport overflow and logout. Tests deliberately use fixtures and leave uniquely named test branches/audits. They are not a substitute for penetration testing, WCAG audit, financial correctness tests or load validation.

The CI file is a runnable definition, not a claim of a completed GitHub run. Local verification results are recorded in `VERIFICATION.md` when checks finish.

## Next implementation batches

1. **P01-M2 Identity and onboarding (partially complete):** M2a–M2e deliver local onboarding/invitations, password recovery, optional MFA, encrypted authenticator storage/private security history and expired bootstrap recovery. M3a supplies durable local email queuing/retries. Remaining: protected master-key storage, security notifications/retention, mandatory MFA/lost-factor policy, production operator flow and real email verification/provider integration. Exit: real-school onboarding and recovery meet an approved policy.
2. **P01-M3 Shared services (started):** M3a delivers the local transactional mail outbox; M3b adds scoped delivery visibility and controlled failed-invitation replacement. Remaining: tenant-bound object storage/scan/quarantine, production notification adapters, other idempotent jobs and audited imports/exports. Exactly-once delivery requires suitable provider idempotency; SMTP retries alone do not guarantee it.
3. **P01-M4 Operational acceptance (started):** M4a delivers scoped invitation/activity pagination. M4b delivers settings concurrency, business-audit database guards and workspace URLs. Remaining: pagination of other capped lists, external audit/observability/alerts, production secret/key handling, application/key recovery evidence, accessibility/security review and agreed load targets. Exit: a production-like staging environment satisfies signed acceptance criteria. No staging host has been supplied.
4. Then begin P02 student/guardian/staff core records after approving its SRS, retention/consent rules and migration fields. Fees, payroll and grading need separate explicit business decisions.

## Decisions needed before real school data

- First target country/region, curriculum/education level and languages.
- Legal tenant/branch structure and who may provision an organization.
- Expected first-year schools, students, active users and peak concurrency; uptime/RPO/RTO budget.
- Hosting region/provider and data-residency/retention requirements.
- Required MFA roles, email/SMS providers and sender identity.
- Whether one employee needs several branch grants; teacher/parent/student access matrix.
- Privacy/consent rules for minors and responsibilities between platform and school.
- Confirmed business workflows before final SRS acceptance. No jurisdiction-specific compliance is asserted.

## Operational limitations

Compose is development-only. PostgreSQL uses a development owner account; migrations and runtime credentials must be separated before deployment. Master-key files are persisted but not encrypted at rest by application configuration. Business audit and account security history both have application guards and database append-only triggers. Neither is immutable external storage. Local key-ring archives are available, but a full application/key restore drill is not verified. Uploaded files, production notifications, payments, SaaS billing, colleges, AI features and mobile apps are not delivered in the current milestones.
