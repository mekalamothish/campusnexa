# Verification record — P01-M1, P01-M2a–M2e and P01-M3a

Updated: 6 October 2026 (Asia/Kolkata). Status: **foundation, successive local identity milestones and local mail outbox verified; full Phase 1 and production readiness remain open.** Earlier sections preserve historical checkpoints; the latest section supersedes their outstanding-work statements where explicitly implemented.

## Passed

| Check | Evidence/result |
| --- | --- |
| ASP.NET Core Release build | 0 warnings, 0 errors |
| EF Core model/migration consistency | `has-pending-model-changes`: no pending changes |
| Angular + Tailwind production build | Successful locally and inside Docker; about 269 kB initial raw bundle, 70 kB estimated transfer |
| Docker Compose validation/startup | Valid configuration; PostgreSQL healthy; migration exits 0; API and nginx running |
| PostgreSQL version | Running container reports 17.11 |
| HTTP/PostgreSQL integration | 19 passing Node test results: 18 subtests and their parent test; 0 failed |
| Database constraints | 4 checks passed: cross-tenant FK, known role, required branch for scoped role and tenant-local code uniqueness; transaction rolled back |
| Desktop browser | Chromium: sign-in, Tailwind color assertion, all six screens, branch creation, directory, module status, preference save/reload/restore, audit and logout passed |
| Mobile browser viewport | Chromium at 390 × 844: viewer scope, hidden admin actions, disabled settings, no page-width overflow and logout passed |
| Invalid login | Generic recoverable error passed |
| Browser suite overall | 3 tests passed in Docker, 0 failed |
| Visual inspection | Reviewed login, desktop overview, settings and mobile overview screenshots after the final CSS fix |
| npm dependency audit | 0 reported vulnerabilities at verification time; this is not a security certification |
| Backup | PostgreSQL custom-format dump plus SHA-256 manifest created |
| Isolated restore | Restored into `campusnexa_verify_05e665ce30cc139e`; primary database untouched; expected schema and migration history queried successfully |

The restored snapshot contained 2 organizations, 6 branches, 4 memberships, 4 users, 2 settings rows, 12 module entitlements, 10 audit events and 1 migration. Later UI/API test runs added additional fixture branches and audit entries to the live development database. The verification database and backup are retained, not deleted.

## Issues found and resolved during verification

- `localhost:4200` resolved to a separate IPv6 development server. Tests and handoff now use `127.0.0.1:4200`; readiness asserts the actual API response instead of accepting arbitrary HTTP 200 pages.
- Angular's native LMDB cache crashed on this macOS host. Disabled the optional persistent build cache while retaining strict checks and production optimization.
- An HTML-only formatter split Angular control-flow string literals. Added an Angular parser override, repaired the literals and rebuilt successfully.
- Angular critical-CSS optimization generated an inline loader script that the existing CSP correctly blocked. Disabled critical-CSS inlining so the stylesheet loads directly. The CSP was not weakened. A browser assertion now verifies a real Tailwind-computed style.
- Host Chromium could not launch under macOS execution permissions. Browser verification completed with the included Linux Docker runner instead.

## Still unverified / not delivered

- No public deployment or actual GitHub CI run.
- No load/soak benchmark, independent penetration test, complete WCAG audit or cross-browser matrix.
- No claim of regulatory compliance, disaster-recovery SLA, immutable audit storage or production-grade tenant isolation certification.
- Recovery rehearsal checks dump integrity, schema and row accessibility; it does not validate every business invariant or restore encryption keys.
- At the M1 checkpoint, invitations and onboarding were outstanding. The M2a results below supersede that portion. MFA, recovery, production onboarding/delivery, file storage and operational controls remain outstanding Phase 1 work. See PHASE1.md.

The application is left running in local Docker. Normal web/API/database containers remain; ephemeral browser test containers were automatically removed by their `--rm` run mode.

## P01-M2a — local onboarding and invitations

Verified 4 October 2026. This is an additional development milestone, not completion of all Phase 1 identity work.

| Check | Evidence/result |
| --- | --- |
| Preservation/migration | Pre-change backup `campusnexa-2026-10-04T15-00-07.638Z-cfdf8b.dump` and manifest retained; additive `20261004150127_Invitations` migration applied without resetting the database |
| Release builds | ASP.NET Core and Angular/Tailwind Docker production builds passed; Angular initial bundle about 282.46 kB raw / 73.06 kB estimated transfer |
| EF model consistency | No pending model changes |
| Foundation regression | Original HTTP suite: 19 passing results (18 subtests + parent), zero failures |
| Invitation/onboarding HTTP suite | 10 passing results (9 subtests + parent), zero failures |
| SQL constraints | 6 checks passed in a rolled-back transaction; includes invitation cross-tenant branch FK and role/scope checks |
| Browser regression and new flow | 4 Chromium tests passed in Docker: original desktop/mobile/login checks plus admin issuance, captured mail, mobile acceptance, restricted-user login and used-link rejection |
| Visual inspection | Reviewed desktop invitation history and mobile acceptance at 390 × 844; Tailwind layout preserved |
| Local runtime | Database, API, web and Mailpit running; migrations exit successfully; no public deployment or remote CI run |

The invitation suite checks admin-only access, foreign-tenant/branch denial, invalid roles, CSRF, duplicate pending invitations, token hash storage and response redaction, weak-password rejection, acceptance/replay, revocation, expiration/reissue, matching existing-user authentication without password replacement, and concurrent acceptance. It also creates a school via the server command without fixture SQL, verifies active-organization/platform-entitlement gates, accepts its initial administrator invitation, and verifies isolation from the original school's administrator.

Browser testing exposed an invitation navigation issue when opening a new fragment in an already-open app tab. A hash-change handler now captures and clears that fragment; the used-link browser check passes after the fix.

Test schools/accounts/invitations, captured local messages and audit events are intentionally retained as fictional development data. The earlier isolated restore result predates the invitation migration; no new post-migration restore rehearsal is claimed. Mail delivery failure/retry resilience, production email verification, MFA/recovery, initial-admin invitation recovery and a durable outbox are not acceptance-complete.

## P01-M2b — local password recovery

Verified 4 October 2026. Local password recovery is now implemented; this supersedes the earlier blanket recovery-pending status, not the production limitations.

| Check | Evidence/result |
| --- | --- |
| ASP.NET Core build | Docker Release publish passed; local API/token-check Release build: zero warnings, zero errors |
| Angular/Tailwind build | Final production build passed: 287.41 kB initial raw / 73.99 kB estimated transfer |
| Locked dependencies | RecoveryChecks project and API restored successfully with `--locked-mode`; no new third-party package introduced |
| Recovery token checks | 7 passed with ephemeral keys and detached users: valid token, wrong purpose, wrong account, 29-minute acceptance, 31-minute expiry, security-stamp rotation and malformed input |
| Recovery API suite | 8 passing Node results (7 subtests + parent), zero failures |
| Foundation/invitation regression | Original API suites: 19 + 10 passing results, zero failures |
| Database constraints | All 6 checks passed; transaction rolled back |
| Browser suite | All 5 Chromium tests passed in Docker after final frontend build, including mobile recovery and existing invitation/workspace flows |
| Visual review | Inspected 390 × 844 recovery form/error state; no horizontal overflow; labelled password fields and confirmation error visible |
| Data preservation | No schema change or migration added, no volume reset, no shared fixture password changed; newly created fictional recovery accounts retained |

The API suite verifies generic acknowledgements, CSRF, suppression for inactive/unconfirmed accounts, token substitution across accounts, tampering, weak-password rejection, revocation of two existing sessions, old-password rejection, unchanged membership/role/branch scope, no automatic login, replay rejection, concurrent reset with exactly one successful result, sibling-link invalidation, unrelated-account preservation and HTTP 429 enforcement for both recovery endpoints.

Browser verification covers the Forgot password link, local message capture, cleared URL fragment, mobile reset form, mismatched confirmation, successful reset, new-password sign-in, used-link rejection in an already-open tab, and navigation to request another link. The host's shared compiler build stalled; disabling build servers/shared compilation completed the isolated token checks. Browser runs use Docker as in prior milestones.

The CI definition includes token and recovery suites, plus rate-window cooldowns between authentication-heavy suites. It has not been run on a remote repository. Unit expiry fixtures age a token with an ephemeral test-only key; they do not access application keys or alter the server clock.

The optional host EF model-consistency recheck stalled and was interrupted; it is not claimed as a new pass for M2b. No entity mappings or migration files changed in this milestone. Final database-backed readiness passed.

Still pending: MFA and its recovery policy, production delivery/provider/outbox, timing-side-channel review, per-account/distributed throttling, password-change notifications, durable security-event audit, expired initial-admin invitation recovery, and production security/accessibility/load acceptance. Generic response text alone is not a constant-time guarantee. Local mail is unauthenticated and must never be exposed publicly.

## P01-M2c — optional authenticator MFA

Verified 4 October 2026. Optional account-wide MFA is now implemented; this supersedes the earlier blanket MFA-pending status. Mandatory enrollment and lost-all-factors recovery policies remain open.

| Check | Evidence/result |
| --- | --- |
| ASP.NET Core | Docker Release publish passed with warnings treated as errors |
| Angular/Tailwind | Final production build passed: 299.50 kB initial raw / 76.36 kB estimated transfer |
| Isolated cryptographic checks | 10 checks passed in a network-disabled Docker container: previous 7 recovery checks plus expired, wrong-purpose and absent MFA challenges |
| MFA HTTP suite | 11 passing Node results (10 subtests + parent), zero failures on final run |
| Regression API suites | Platform 19, invitations 10, password recovery 8 passing results, zero failures |
| SQL constraints | All 6 existing checks passed; test transaction rolled back |
| Browser suite | All 6 Chromium tests passed after final frontend formatting/build, including mobile MFA enrollment and existing-account invitation challenge |
| Visual review | Inspected mobile account-security/recovery-code panel and sign-in challenge/error state; screenshots mask recovery codes; overflow assertion passed |
| Data/runtime | No schema migration or volume reset; existing Identity token tables used; shared fixture passwords and MFA settings unchanged; Docker readiness passed |

MFA API tests verify password/CSRF-protected enrollment, no target-user selection, TOTP proof, recovery-code hash storage, preserved tenant/branch/viewer restrictions, unauthenticated password-only challenges, HttpOnly/SameSite cookie flags, tampered/replayed challenges, used-TOTP rejection, concurrent recovery-code consumption with one winner, latest-challenge supersession, inactive-account denial, password-reset invalidation without MFA removal, code replacement/session invalidation, five-attempt lockout, password not clearing that lockout, protected disable and HTTP 429 enforcement. The suite temporarily deactivates and clears lockout only for its uniquely created fictional account; it does not modify shared fixtures.

Browser coverage includes manual key enrollment, one-time recovery-code display, error feedback, recovery-code sign-in, absence of workspace navigation before MFA, an existing MFA-enabled account accepting a second school's invitation, and explicit-confirmation disable. Existing login, preferences, branches, invitations and password-recovery flows still pass. No actual phone authenticator was tested: automated checks generate standards-compatible TOTP codes from their own fictional setup key.

A local rerun immediately after recovery's deliberate rate-limit exhaustion received HTTP 429. Rerunning after the fixed window elapsed passed; the application limits were not weakened. CI and README include sequential cooldowns. The macOS .NET build stalled in GenerateDepsFile and was interrupted; the new Docker check runner built and passed instead. No new host EF model-consistency or remote CI pass is claimed.

Before real use: encrypt authenticator secrets at rest, protect Data Protection keys, define mandatory MFA and lost-factor policies, add durable security audit/notifications and production delivery, complete operator/bootstrap recovery, and perform independent security/accessibility/load review. Manual setup is delivered; QR setup, passkeys and remembered devices are not. Current MFA is optional and does not make Phase 1 production-complete.

## P01-M2d — encrypted authenticator storage and private security history

Completed across 4–5 October 2026. Authenticator database encryption and durable account security history supersede the corresponding pending items above. Protecting the master-key files, production rollout and full Phase 1 acceptance remain open.

| Check | Evidence/result |
| --- | --- |
| ASP.NET Core Release build | Docker build succeeded with zero warnings and zero errors |
| EF model consistency | Rebuilt Docker EF tool image; `has-pending-model-changes` reports no changes since the last migration |
| Angular/Tailwind final build | Docker production build passed on 5 October: 302.27 kB initial raw / 77.06 kB estimated transfer |
| Final browser suite | All 6 Chromium tests passed after final build; history survives reload/refresh and shows enrollment, failure and disable events; page and history table both fit 390 × 844 viewport |
| Visual review | Reviewed final mobile security-history screenshot; event names and complete timestamps wrap without sideways scrolling; no setup/recovery secrets shown |
| Migration and preservation | Additive `20261004180407_SecurityHistory` applied; migration exited 0; six pre-existing legacy authenticator keys encrypted; no database/volume reset |
| Isolated crypto checks | 19 passed in a network-disabled container, including account-bound encryption, tamper/unknown-format/plaintext rejection, missing-key failure and persistence across a provider restart |
| New storage/history API suite | 8 passing Node results (7 subtests plus parent), zero failures |
| API regressions | Platform 19, invitations 10, password recovery 8 and MFA 11 passing results; **56 total Node results** including the new suite and all parent tests |
| SQL guards | 10 passed in a rolled-back transaction: prior six constraints plus security-event update/delete/truncate rejection and action allowlist |
| Key archive | Owner-only key-ring tar and SHA-256 manifest created without printing key contents; archive is not encrypted and has not undergone a full application restore drill |
| Database restore | Post-migration dump restored into isolated `campusnexa_verify_d45e3df882177d33`; three migrations, SecurityEvents and both enabled append-only triggers present; live database untouched |

The new API suite verifies ciphertext at rest and successful TOTP use, refusal of ciphertext copied between accounts, atomic legacy-upgrade rollback when another key is corrupt, idempotent repeat upgrade and unchanged TOTP secret. It checks anonymous denial, same-school account isolation including administrators, ignored forged account/role selectors, absent target-account endpoints, secret-free response projections and the newest-first 100-event cap. Its injected audit-write failure proves password/stamp changes roll back without invalidating the old session; removing the test-only fault permits the same recovery token to complete exactly once. Test-only key tampering is confined to uniquely created accounts and restored in finally blocks; shared fixture credentials/factors are unchanged.

Backups retained: pre-upgrade database `campusnexa-2026-10-04T18-00-46.895Z-ff5142.dump`, key ring `campusnexa-keys-2026-10-04T18-05-37.551Z-a52e33.tar`, and post-upgrade database `campusnexa-2026-10-04T18-20-59.823Z-499865.dump`, each with a manifest. The isolated restored snapshot contains 7 organizations, 31 branches, 49 memberships, 42 users, 7 settings, 42 entitlements, 200 business audit events, 60 invitations and 201 security events. Later browser runs add fictional records. A permission-denied backup attempt left `campusnexa-2026-10-04T18-20-47.282Z-859204.dump` without a success manifest; it is **not a valid backup**. No backup or database was deleted.

CI and README now include the storage/history suite with authentication-rate-window cooldowns. No remote CI run or public deployment is claimed. README documents the maintenance-window upgrade and the distinction between encrypted database secrets and the still-unprotected master-key volume. Key loss must not be worked around by deleting the volume or silently resetting factors.

Docker was stopped when work resumed on 5 October. `docker desktop start` brought the engine back; the final Compose build/start, successful migration and database-backed readiness were rechecked before the browser suite. The development stack is left running at `http://127.0.0.1:4200`. No live database or key volume was replaced.

The optional host Angular build stalled and was interrupted; only the successful Docker build is claimed for this checkpoint. The Docker startup CLI also remained waiting after the engine was healthy and was canceled; the engine and application remained healthy afterward.

Remaining: production master-key protection and full key/application recovery drill; batched migration for large deployments; approved security-event retention/erasure, external monitoring and notifications; initial-admin invitation recovery; durable email/outbox; mandatory MFA/lost-factor policy; production operator identity and independent security, accessibility and load acceptance. The next bounded implementation slice is trusted-local-operator bootstrap invitation recovery/reissue, not student or finance workflows.

## P01-M2e — expired bootstrap invitation recovery

Implemented 5 October 2026. This supersedes the earlier pending local initial-administrator invitation recovery item. Recovery of an established administrator account and production operator identity remain unresolved.

- Docker ASP.NET Core Release publish passed with warnings treated as errors; no schema or dependency change.
- Expanded invitation/onboarding suite passed all **17 Node results** (including parent tests), with zero failures. The new command tests cover read-only status and secret redaction, rejection of unexpired links, production/disabled-mail gates, a foreign invitation ID, an unknown school, inactive schools and disabled platform access.
- Two concurrent reissues produced one successful replacement. Old links and stale invitation IDs were rejected. Replacement acceptance preserved the recipient's organization-admin role and school boundary, exposed the linked audit event to that school's administrator, and closed further bootstrap recovery. **Correction discovered in M3a:** the former SMTP-failure test used an unsupported Compose flag and accepted its nonzero exit as a delivery refusal; it did not prove SMTP rollback. M3a replaces that test with a scoped database queue-write fault and verifies actual SMTP failure through persisted dispatcher state.
- All **10 SQL constraint/append-only checks** passed inside a rolled-back transaction.
- Foundation regression: **19 Node results passed**. All **6 Chromium browser tests passed** against the updated API, covering invitation acceptance, MFA, account security, desktop/mobile permissions and password recovery. Authentication-heavy suites ran sequentially with cooldowns.
- Web image build succeeded using the unchanged cached Angular/Tailwind production bundle. No frontend source change. The updated API is running and database-backed readiness passed.

Expected command refusals originally propagated as unhandled process errors, causing test timeouts. Added clean nonzero CLI exits and generic infrastructure-failure output; tests now reject timeouts as test failures rather than treating them as valid refusals. The final invitation suite completed in about 24 seconds. Four temporary command containers from the interrupted first attempt were stopped; shared service volumes and test data were retained.

README now provides exact inspection/reissue commands. CI already invokes the expanded suite. No HTTP route, UI change, password/factor reset, recipient override, migration or production deployment was introduced. Local operator audit records use an empty actor ID until production operator authentication is designed. SMTP-before-commit remains a documented limitation; the next implementation slice is the transactional outbox and local mail worker.

## P01-M3a — encrypted transactional mail outbox and local worker

Completed 6 October 2026. Invitations, onboarding, bootstrap reissue and password recovery now commit encrypted mail jobs with the relevant domain/audit changes. This supersedes earlier synchronous-SMTP and local-outbox-pending statements. Real email provider integration remains open.

| Check | Evidence/result |
| --- | --- |
| Backend production build | Docker Release publish passed; EF tools build reports zero warnings/errors |
| Model consistency | `has-pending-model-changes` reports no changes since migration |
| Migration | Additive `20261005045332_MailOutbox` applied; existing database/key volumes retained |
| Angular/Tailwind build | Passed, 302.29 kB initial raw / 77.02 kB estimated transfer; invitation feedback now says queued |
| Outbox integration | 8 passing Node results, including parent; zero failures on final run |
| Regression APIs | Platform 19, invitations/bootstrap 17, password recovery 8, MFA 11, storage/history 8; **71 total Node results** with outbox and parent tests |
| SQL guards | All 14 checks passed in a rolled-back transaction, including new mail tenant FK, scope check, attempt bound and one-job-per-invitation constraint |
| Browser regression | All 6 Chromium tests passed using asynchronous mailbox polling; invitations, recovery, MFA and desktop/mobile workspace flows verified |
| Backup restore | Post-migration dump restored into isolated `campusnexa_verify_3ae6d14f936a8637`, including MailQueue and four migrations; original database untouched |
| Runtime/operator check | API readiness passed; worker running; `--mail-status` returned aggregate counts without recipients/payloads; zero pending jobs at final check |

Outbox tests verify encrypted storage/response redaction, absent public queue endpoints, tenant-FK enforcement, actual SMTP failure with persisted attempt/backoff state, independent dispatcher restarts, concurrent claim exclusion, one observed message under ordinary competing-worker delivery, payload removal after delivery, revoked/expired suppression, cross-message ciphertext rejection, bounded terminal recovery failure plus private audit, security-stamp cancellation and pending-job delivery after worker restart. They do not simulate a crash in the exact SMTP-accepted/database-uncommitted interval and do not prove exactly-once delivery.

The bootstrap regression now injects a queue-insert failure scoped to its newly created school and proves revocation, replacement and audit roll back together. The temporary trigger is removed in a finally block. SMTP outage tests use `tests/compose.mail-unavailable.yaml` only for the selected one-shot dispatcher. The worker is temporarily stopped and restored by the outbox suite; the shared Mailpit service remains running. Fictional rows/messages are retained. Final queue status showed 27 Sent, 7 Cancelled, 3 Dead and 2 Expired jobs; terminal failures are intentional fixtures.

Verification exposed stale nginx DNS after API and worker container recreation: the old API IP belonged to the worker, which returned 404 for readiness. The proxy now uses Docker's resolver with a ten-second refresh. Readiness and the complete API/browser regressions passed after this change. A first outbox run also exposed the unsupported `compose run --add-host` test option; replaced it with a Compose override and reran actual retry/exhaustion checks successfully.

Pre-upgrade backups: `campusnexa-2026-10-05T04-55-10.584Z-caaed2.dump` and `campusnexa-keys-2026-10-05T04-55-10.831Z-e95374.tar`, with manifests. Post-upgrade dump: `campusnexa-2026-10-05T18-34-26.930Z-cc106b.dump`. The restored snapshot contains 13 organizations, 42 branches, 82 memberships, 69 users, 13 settings, 78 entitlements, 321 business audit events, 115 invitations, 516 security events and 34 queued/terminal mail records. Later browser checks added fictional records. No worker connects to the isolated restore target. This remains a database restore smoke test, not a full key/application recovery drill.

README, PHASE1 and MAIL.md document operation, expiry, retry delays, terminal states, secrets and the at-least-once SMTP limit. CI includes the new outbox suite; no remote CI run or public deployment is claimed. Remaining: scoped delivery visibility and controlled failed-job recovery, production provider/sender ownership, protected master keys, monitoring/retention, production operator identity, and full Phase 1 acceptance.

Final cleanup stopped the temporary `--migrate` command container left by the storage suite's intentional corrupt-key failure. Database, key volumes and the normal worker/API/web/mail services were retained.

## P01-M3b — invitation delivery visibility and controlled retry

Completed 6 October 2026. Organization administrators can now see safe delivery metadata in People & access and explicitly confirm a retry of terminal failed delivery for a still-active invitation. This supersedes M3a's pending delivery-visibility/retry item; production mail and full Phase 1 acceptance remain open.

Retry creates a new invitation secret and job, atomically revokes the old invitation and records an actor-attributed audit linking both IDs. Recipient, normalized email, role, branch and original expiry are preserved. The original terminal job remains untouched. Existing worker-only mutation guards remain in force; HTTP handlers opt into EF-filtered tenant/admin/Invitation-only reads and never select payloads or account recovery jobs. No endpoint filter bypass, raw SQL, new dependency or schema migration was introduced.

| Check | Evidence/result |
| --- | --- |
| Backend production build | Docker Release publish passed; EF tools build reported zero warnings/errors |
| Model consistency | `has-pending-model-changes` reported no changes since the last migration |
| Angular/Tailwind production build | Passed, 318.13 kB initial raw / 81.00 kB estimated transfer; strict template compilation retained |
| New delivery-management integration | 9 passing Node results including parent; final repeat passed, zero failures |
| API regressions | Platform 19, invitation/onboarding/bootstrap 17, outbox 8; **53 passing Node results** including the new suite and parents |
| SQL guards | All 14 checks passed in a rolled-back transaction |
| Browser suite | All 7 Chromium tests passed: six real-stack regressions plus one explicitly mocked delivery-state/confirmation UI test |
| Runtime | Database-backed readiness passed; API/web/worker/database/Mailpit running; aggregate mail status had no pending jobs at inspection |

New HTTP/PostgreSQL tests cover exact metadata allowlisting, both-school isolation, legacy untracked invitations, no payload/token/hash/internal-error exposure, anonymous denial, branch/viewer denial, forged scope headers, cross-school route/resource mismatches, missing CSRF, inactive school/member and disabled platform. Retry refuses pending/sent/cancelled/expired/untracked delivery and expired/accepted/revoked invitations. Request body overrides cannot change recipient or permission scope. Two concurrent requests produce one replacement and one 409; stale requests and the old capability then fail. Actual replacement delivery and single-use acceptance preserve the invited branch/viewer membership. Account recovery metadata remains absent from the school invitation response.

A temporary queue-insert fault scoped to one fresh fictional email proves old-invitation revocation, replacement and linked audit roll back together; removing the trigger permits retry. Trigger/function cleanup runs in a finally block. Terminal-state fixtures and one untracked legacy fixture are created only for this suite; it does not reset volumes or change shared fixture credentials. School/member/platform activation changes are restored after their negative checks. The worker is stopped only during deterministic test setup and restored afterward. The outbox suite additionally verifies that a real cross-message ciphertext failure can be replaced and delivered without reviving its original Dead job; persisted SMTP failure/backoff/exhaustion checks still pass.

The browser suite checks actual sent-status display/refresh and existing invitation acceptance. Its separately named mocked-state mobile test covers all delivery labels, retry eligibility, explicit confirmation, cancel-without-request, conflict handling, successful queued feedback, keyboard focus transfer/return and 390-pixel viewport overflow. Backend isolation and transaction claims come from the real integration suite, not the mocked UI test. The existing MFA, recovery and role-limited workspace browser flows also pass. API-only recovery/MFA/storage suites and the full backup/key restore drill were not rerun for this metadata/replacement change; prior evidence is retained above.

Visual review identified awkward horizontal scrolling in the initial mobile invitation table. The final Tailwind layout stacks labelled fields on small screens while retaining the desktop table. The final full browser rerun passed all seven tests, including separate page/table no-overflow assertions. Reviewed the mobile retry confirmation and final mobile/desktop history screenshots; fixture states in the UI-only screenshots are explicitly synthetic.

The first new test attempt stopped on a test-helper mistake (CSRF issuance returns 204, not 200). Corrected that expectation and reran the complete suite successfully. No application fix or database reset was used to hide the failure. README, MAIL.md, PHASE1 and the CI definition now include M3b usage, security boundaries and verification commands. No remote CI run or production deployment is claimed.

Next bounded slice: cursor pagination for growing invitation/audit history. Remaining production work includes real sender/provider verification, protected master keys, delivery monitoring/retention, production operator identity, approved MFA/recovery policy and operational acceptance. School-domain modules still require approved business rules.

## P01-M4a — scoped invitation and activity pagination

Completed 6 October 2026. The invitation and workspace-audit GET endpoints now return `{ items, nextCursor, startCursor, pageSize, snapshotAt }`; the former bare-array/100-record-cap contract is superseded. Default size is 25, maximum 100. Angular provides Older/Newer/Refresh controls, retains the current page after a request error and ignores responses arriving after its component is destroyed. Only the current page and a cursor trail are kept in memory.

Cursors are time-limited Data Protection values bound to resource, user, tenant, role, branch and page size. Every page still validates current membership/organization/platform access and retains EF filters. Queries seek by timestamp plus UUID, in PostgreSQL descending order, and retrieve only size-plus-one projected rows. The browsing cutoff excludes rows with later timestamps; it is not a long-running transaction, immutable database snapshot or export guarantee. Live invitation/delivery fields can change between requests. No identity/mail payloads or invitation hashes were added to responses.

| Check | Evidence/result |
| --- | --- |
| Backend production build | Docker Release publish passed; EF tools build reported zero warnings/errors |
| Model consistency | EF `has-pending-model-changes` reported no changes after the generated migration |
| Migration | `20261005193637_HistoryPagination` applied; all three ordered history indexes confirmed in the live database |
| Angular/Tailwind production build | Passed; final bundle 323.19 kB initial raw / 82.02 kB estimated transfer |
| Pagination API suite | 8 passing Node results including parent; final uninterrupted repeat passed in about 2.5 seconds, not a load benchmark |
| API regressions | Platform 19, invitation/bootstrap 17, delivery management 9, outbox 8; **61 passing Node results** including pagination and parents |
| Isolated cryptographic checks | All 27 checks passed in a network-disabled container, including eight history-cursor checks and the prior 19 recovery/MFA/storage checks |
| Final browser regression | All 9 Chromium tests passed after the mobile fix: seven real-stack flows and two explicitly mocked UI-state tests |
| SQL guards | All 14 existing constraint/append-only checks passed in a rolled-back transaction |
| Database restore | Isolated restore succeeded with five migrations, both security-history triggers and all three new history indexes; live database untouched |

The pagination suite seeds unique revoked historical invitations and audit fixtures in both fictional schools, including equal microsecond timestamps. It compares complete multi-page results against actual PostgreSQL ordering, verifies reachability past 100 rows without duplicates, exact branch/viewer isolation and an empty branch result. It rejects malformed/empty/duplicate/out-of-range parameters, altered cursors, wrong resource/tenant/page size, forged scope headers and a changed branch grant. It tests permission revocation after cursor issuance and distinguishes start-cursor reuse from refresh when new records are inserted. Temporary fixture membership/platform changes are restored in finally blocks. The resumed interrupted run completed; its extended wall time is not used as latency evidence. HTTP/SQL test calls now have explicit timeouts, and the final uninterrupted repeat passed.

Isolated cursor tests use throwaway keys to check round-trip seek/start positions, resource/user/role/branch binding, expiry and missing-key rejection. Existing recovery and authenticator checks still pass. The API-only recovery/MFA/storage regression suites were not rerun for this history-contract change; their earlier evidence remains recorded above.

The first full browser run found a genuine mobile overflow: long activity subjects inherited table `white-space: nowrap`. Added small-screen wrapping to the shared stacked history-row recipe. The targeted real-stack pagination browser test and the final full nine-test browser run then passed. Browser cases cover real Older/Newer/Refresh and mobile table/page overflow, plus an explicitly mocked error/end/loading/abandoned-response test. Screenshots of mobile navigation and a wrapped activity row were visually reviewed. The existing MFA, invitation, account recovery and role-limited workspace flows still pass.

Pre-migration backups retained: `campusnexa-2026-10-05T19-41-38.190Z-903a05.dump` and `campusnexa-keys-2026-10-05T19-41-38.399Z-e307f4.tar`, with manifests. Post-migration dump `campusnexa-2026-10-06T03-50-35.823Z-ff3c6c.dump` restored into `campusnexa_verify_34213f1601c6506d`. The snapshot contains 15 organizations, 57 branches, 110 memberships, 91 users, 15 settings, 90 entitlements, 736 business audit events, 455 invitations, 698 security events and 158 mail records. Later tests add fictional records. The new composite branch/activity index replaces the narrower branch index; no rows, columns, database volumes or master keys were deleted. The restored database is retained and has no connected worker. This is not a full application/key-ring recovery drill.

README, PHASE1, MAIL.md and the new HISTORY.md document the UI, breaking local GET-envelope change, cursor lifetime, time-cutoff limits and upgrade procedure. CI now includes the pagination suite; no remote run or deployment is claimed. Remaining: other capped directories/private security history, settings optimistic concurrency, production key/provider/operator policies, observability, independent accessibility/security assessment and agreed load targets. Full Phase 1 remains open.

Final database-backed readiness passed and all five normal services are running. The aggregate mail-status command exited 0 with no pending jobs; terminal failures are test fixtures. That operator command still emits a nonfatal missing `libgssapi_krb5.so.2` diagnostic before returning its counts. Runtime dependency cleanup remains separate from this pagination change.

## P01-M4b — settings conflicts audit guards and workspace URLs

Completed locally 7 October 2026. Organization defaults and branch overrides now require resource versions. Stale saves return 409; missing versions return 428; accepted saves rotate the version and commit their success audit in the same transaction. The browser retains rejected drafts, disables stale saves and provides explicit discard/reload controls. Branch reload preserves a separate organization draft. Generic retry is hidden while a settings form is already open so a service error cannot silently discard it.

The additive `20261006041606_SettingsConcurrencyAndAuditGuards` migration initialized random versions on existing settings/branches and added database triggers rejecting business-audit update/delete/truncate. It deleted no rows or columns. Database owners can disable these guards; external immutable logging remains open.

Seven workspace URLs survive sign-in/reload and browser Back/Forward. The shell validates the URL against current memberships/role visibility before selecting a view; APIs still enforce authorization. Tenant-specific history/invitation components are recreated on a school change, and stale page/settings responses are ignored. This uses the browser History API, not a lazy-loaded Angular Router tree.

| Check | Result |
| --- | --- |
| Backend Release build | Passed; EF tools build had zero warnings/errors |
| EF model consistency | No pending model changes after the migration |
| Angular/Tailwind production build | Passed; 327.99 kB initial raw / 83.17 kB estimated transfer |
| Settings/platform integration | 29 passing Node results with sequential fixture execution |
| History pagination regression | All 8 results passed |
| URL parsing/permission checks | All 4 checks passed |
| Cryptographic regression | All 27 checks passed in a network-disabled container |
| Browser regression | All 14 tests passed in the final isolated run, including the explicit-reload UI change |
| SQL constraints | All 17 checks passed in a rolled-back transaction |
| Restore | Isolated database `campusnexa_verify_95a1dc6e992672ae` restored six migrations, both security-history guards, both business-audit guards and nonempty settings/branch versions |
| Source publication guard | 103 staged source files passed checks; local passwords, runtime files and backups were excluded |

The new integration suite holds database write locks while two HTTP handlers read the same version; exactly one update and one success audit commit. It also checks no-op replay, missing/malformed/foreign versions, permission and CSRF boundaries, override inheritance, validation, and another school's unchanged defaults. Values are restored using fresh versions.

An initial malformed UUID returned 500; safe BadHttpRequestException handling now returns the appropriate 4xx status without exposing parser details. An initial combined API run mistakenly allowed two fixture suites to execute concurrently; sequential execution passed. An interrupted browser test left its known year-label fixture; it was conditionally restored without changing other values. A subsequent overlapping API/browser run exhausted the shared login limiter; the final browser suite ran alone and passed all 14 tests. Production limits were not relaxed.

Pre-migration database/key backups: `campusnexa-2026-10-06T04-15-05.125Z-09f68d.dump` and `campusnexa-keys-2026-10-06T04-15-05.419Z-3214e1.tar`. Post-migration dump: `campusnexa-2026-10-06T04-27-22.272Z-b6c395.dump`. The isolated restore retained 17 organizations, 67 branches, 125 memberships, 103 users, 17 settings, 102 entitlements, 1145 business audits, 769 invitations, 821 security events and 253 mail records. These are fictional test records. Full application/key recovery remains unverified.

The GitHub repository was supplied and initial publication authorized. Source push/remote workflow evidence will be recorded after the operation; no remote CI or staging success is claimed here. PHASE1-CHECKLIST.md fixes the original six-package exit and keeps Phase 2 on hold.
