# CampusNexa · Platform foundation

Independent multi-school, multi-branch school management product. Preskool is a functional reference only; its source code, brand and assets are not included.

**Stack confirmed:** Angular 22 + Tailwind CSS 4, ASP.NET Core 10, PostgreSQL 17, Docker Compose. PostgreSQL replaces the earlier open SQL Server/PostgreSQL decision. This is a local development milestone, not the complete ERP or a production release.

## Start

Requirements: running Docker Engine/Desktop with Compose, and Node.js 24 for setup/tests.

From this directory:

```sh
node scripts/init-local.mjs
docker compose up --build -d
node scripts/wait-ready.mjs
```

Open **[CampusNexa](http://127.0.0.1:4200)**. Use `127.0.0.1`, not `localhost`: another service on this machine answers IPv6 localhost on port 4200. CampusNexa is bound only to IPv4 loopback and is not published to your network.

The first run downloads images, migrates PostgreSQL and creates two fictional organizations. Subsequent starts preserve data. The migration service exiting with code 0 is expected.

### Local accounts

| Email | Organization | Scope |
| --- | --- | --- |
| `admin@campusnexa.test` | Greenfield Education | Organization administrator; all its branches |
| `branch@campusnexa.test` | Greenfield Education | Main Campus administrator only |
| `viewer@campusnexa.test` | Greenfield Education | Main Campus read-only viewer |
| `other@campusnexa.test` | Lakeside Learning | Administrator of a separate organization |

All fixture accounts initially use the generated `ADMIN_PASSWORD` in the local `.env` file. Open that file locally to retrieve it. It is ignored by Git and created with owner-only permissions. Do not paste it into tickets or commit it. These accounts are development fixtures, not a production onboarding system.

`init-local.mjs` never replaces an existing `.env`. Editing `ADMIN_PASSWORD` later does **not** change already-created accounts. Changing the database password in `.env` also does not rotate the password inside an existing PostgreSQL volume.

## Working features

- Cookie-based sign-in, logout, all-session revocation and password lockout.
- Optional account-wide authenticator MFA, second-step sign-in, one-use recovery codes and self-service factor management.
- Account-bound encryption for authenticator secrets and private, persisted security history in Account security.
- Local password recovery with 30-minute links, password confirmation and invalidation of prior sessions/links after reset.
- Membership-validated tenant context; server-side organization and branch access checks.
- Branch listing and creation, with tenant-local unique codes.
- Scoped member directory (read-only in this milestone).
- Organization-admin invitations: role/branch assignment, expiry, revocation and single-use acceptance for new or existing accounts.
- Controlled local school onboarding through a server-side command, with an initial administrator invitation.
- Encrypted PostgreSQL mail queue and a background worker with bounded retries for invitations and password recovery.
- School-admin invitation delivery status and controlled retry of permanently failed, still-active invitations.
- Cursor-paginated invitation and workspace activity histories, including older records beyond the previous 100-row cap.
- Organization preferences and branch overrides for timezone, locale and currency.
- Conflict-safe preference saves: stale changes are rejected, drafts retained, and reloading saved values is explicit.
- Bookmarkable workspace pages with sign-in return, browser reload and Back/Forward support.
- Persisted change history for organization setup, branch creation and preference updates.
- Module entitlement status; planned modules cannot be used through the API.
- Responsive Angular/Tailwind workspace: overview, branches, people, modules, activity and settings.
- PostgreSQL migrations, persistent data/key volumes, health endpoints and repeatable automated checks.

No fake student totals or fabricated school data are shown. Platform counters come from PostgreSQL; school modules are explicitly labelled planned.

## Try invitations and school onboarding

Sign in as an organization administrator, open **People & access**, and invite a fictional email address. Choose a role and, for a branch administrator or viewer, its branch. Open the captured message in the **[local test inbox](http://127.0.0.1:8025)**. Open the invitation link in a private browser window or sign out first to create a new account. Existing users must sign in with the invited email and their original password before joining another school.

Links expire after 48 hours and can be accepted once. Administrators can revoke pending invitations; revoking an accepted invitation is not a way to remove a membership. Expired invitations can be replaced from People & access. Invitation history shows 25 entries per page, with **Older/Newer** controls; refresh returns to the newest page. Activity log uses the same pagination. See [history navigation and API contracts](docs/HISTORY.md).

To create an additional fictional school without editing database records, start the stack first and run:

```sh
docker compose run --rm --no-deps \
  -e Onboard__Name="Example Academy" \
  -e Onboard__Slug=example-academy \
  -e Onboard__Email=owner@example.test \
  api --onboard
```

This creates the organization, its Main Campus, default settings, module entitlements and an administrator invitation. Retrieve the link from the local inbox. Reusing an existing slug is rejected; the command does not overwrite a school. This is a **development-only server-operator command**, not public registration or a production operator portal.

### Recover an expired first-administrator invitation

For a school created by the command above whose first invitation expired before acceptance, inspect its status:

```sh
docker compose run --rm --no-deps \
  -e Bootstrap__Slug=example-academy \
  api --bootstrap-status
```

The read-only result includes `eligible`, the reason if blocked, the original recipient, expiry and `invitationId`. It never prints an invitation secret. If eligible, use that exact invitation ID:

```sh
docker compose run --rm --no-deps \
  -e Bootstrap__Slug=example-academy \
  -e Bootstrap__InvitationId=PASTE-INVITATION-ID-HERE \
  api --reissue-bootstrap
```

Open the new message in the [local test inbox](http://127.0.0.1:8025). The replacement lasts 48 hours and keeps the original email and organization-administrator role. The old invitation is revoked and a linked audit event records both IDs. Reusing the old ID cannot issue another replacement.

Recovery requires an active school, enabled platform access, no memberships (including inactive ones), an onboarding audit record and an unambiguous bootstrap invitation history. Unexpired links, accepted/revoked invitations, established schools and non-development environments are refused. This command cannot change the recipient or recover a deleted/lost administrator account. Revocation, replacement, audit and the encrypted email job commit together. A queue write failure rolls them back; a later SMTP outage triggers worker retries.

Mailpit captures messages locally; **no internet email is sent**. Anyone with access to this local inbox can read invitation and recovery secrets, so it does not prove ownership of a real email address. Do not use real personal data. Captured messages are ephemeral and may disappear when the mail container is recreated. Pending jobs survive in PostgreSQL. Production email verification and provider integration remain open.

### Background email delivery

Successful invitation requests now say **Invitation queued**. Allow a few seconds for the worker to deliver the message. Recovery acknowledgements remain generic. Check local delivery with:

```sh
docker compose run --rm --no-deps api --mail-status
docker compose logs --tail=50 worker
```

The worker retries failed SMTP submissions up to five attempts, suppresses expired/revoked links, and clears message contents after a terminal result. A crash after SMTP accepts a message can still cause a duplicate on retry; exactly-once email delivery is not claimed. See [mail operation and recovery instructions](docs/MAIL.md).

In **People & access → Invitation history**, select **Refresh invitations** to see queued, retry-scheduled, sent, failed, expired or cancelled delivery. **Sent to test inbox** means SMTP accepted the message, not that a person read it. Invitations created before delivery tracking show **Not tracked**.

For a permanently **Failed** delivery whose invitation is still pending and unexpired, select **Retry delivery**, review the confirmation, then **Confirm retry**. This revokes the old invitation and queues a new link for the **same email, role and branch, keeping the original expiry**. It does not extend access or resend an already-sent message. Concurrent/stale retries are rejected; a queue-write failure leaves the original invitation unchanged. Only that school's organization administrators have this permission. Account password-recovery delivery is not exposed to school administrators. If the invitation has expired, issue a new invitation using the existing form instead.

## Try password recovery

On the sign-in screen select **Forgot password?**, enter a fictional account's email, then open its message in the [local test inbox](http://127.0.0.1:8025). Follow the link and enter/confirm a new password. Links last 30 minutes. After a successful reset, sign in again: old passwords, existing sessions and previously issued recovery links no longer work. Memberships and roles are unchanged. Recovery applies to the shared account across all its schools, not just one branch.

The request acknowledgement is intentionally the same for existing, unknown, inactive and unconfirmed accounts. Only active, email-confirmed accounts receive a message. Requesting a link alone does not change the password or sign out sessions. Several unexpired links may exist until one reset succeeds; a new request does not cancel earlier links. Existing temporary login lockouts are not cleared by resetting the password.

Use a newly invited account for recovery experiments: resetting a built-in fixture password would make the automated fixture suites fail because `.env` still contains its original password. Recovery tests create their own accounts and never change the four shared fixture passwords. This recovery flow is deliberately disabled outside Development/local mail mode; it is not ready for real customers.

## Try authenticator MFA

Use a newly invited fictional account, sign in, and open **Account security**. Do not enroll the four shared fixture accounts if you want the existing automated tests to keep working unchanged.

1. Enter the current password and select **Set up authenticator**.
2. In an authenticator app, add a time-based account manually using the displayed setup key. Use the name CampusNexa and the account email. QR enrollment is not implemented yet.
3. Re-enter the password and the six-digit code, then select **Enable MFA**.
4. Save the ten recovery codes privately outside the browser. They are shown once; each works once. The application stores only recovery-code hashes.
5. Sign out and sign in. After the password, enter a fresh authenticator code or select **Recovery code**. The second-step request expires after five minutes. Starting another password sign-in for the same account replaces the earlier pending challenge.

A code already used for setup, sign-in or management cannot immediately be reused: wait for the authenticator's next code. Five failed second-factor attempts trigger the account's temporary ten-minute lockout. MFA applies across the account's schools without changing roles or branch grants. Existing-account invitations also support the second-step challenge.

Account security can replace recovery codes or disable MFA using the current password **and** an authenticator/recovery code. Disabling requires an explicit checkbox in the UI. Security changes invalidate other sessions while refreshing the current one. Disabling removes recovery codes and rotates the authenticator key. Password reset leaves MFA enabled and invalidates pending sign-in challenges. If you lose both the authenticator and all recovery codes, there is **no support bypass** yet; the operational recovery policy is still pending.

Authenticator secrets in the Identity token table are now encrypted using account-bound ASP.NET Core Data Protection. Runtime reads reject plaintext, altered ciphertext, another account's ciphertext and unknown formats. The underlying Data Protection key files are still **not encrypted at rest** by this development configuration: someone with both database and key-ring access can decrypt secrets. Keep both private. Mandatory MFA policies, protected master-key storage, passkeys, support-assisted recovery, security notifications and independent review remain outstanding. No real accounts should be enrolled here.

### Security history

Open **Account security → Security history** for the latest 100 events, newest first, across your account's schools. It records attributable sign-ins/failures, MFA changes, password recovery/reset, sign-out, session revocation and legacy-key upgrades. Only the signed-in account can read its own history; organization administrators do not gain access to members' histories. The API exposes only event ID, action and UTC timestamp; the screen uses your browser timezone.

No passwords, tokens, authenticator/recovery codes, IP addresses or device details are recorded in this table. Unknown-account and unattributable requests are not listed, so this is not a complete intrusion-detection log. Identity changes and their events commit together where they share a database transaction; local SMTP delivery is still a separate operation. Application guards and database triggers reject history update/delete/truncate, but a database owner can bypass those controls. This is not immutable external audit storage. Approved retention/erasure and monitoring policies remain open.

### Upgrade an existing local installation

Before the first upgrade from plaintext authenticator storage, while the old API is still running:

```sh
node scripts/backup.mjs
node scripts/backup-keys.mjs
docker compose build api web
docker compose stop api
docker compose up -d
node scripts/wait-ready.mjs
```

Keep the old API stopped during migration. The one-shot migration creates the security-history table, then validates encrypted keys and converts legacy keys transactionally without changing their TOTP secrets. A corrupt key aborts the entire key-conversion transaction; schema migration is separate. Repeating conversion is safe. Conversion currently reads all authenticator rows into memory, so large installations need a reviewed batched migration before rollout.

If migration fails, inspect its status and retain the database and original key volume. **Never delete or replace the key volume to fix a decryption error.** Do not restart an old binary against encrypted rows. A rollback needs a reviewed maintenance-window restore of the matching pre-upgrade database and key ring. The supplied restore verifier never overwrites the live database and is not a rollback command. These instructions apply to local development, not a production rolling deployment.

## Verification

Settings concurrency and workspace navigation checks:

```sh
node --test tests/navigation.test.mjs
ALLOW_FIXTURE_WRITES=1 node --env-file=.env --test --test-concurrency=1 tests/platform.integration.test.mjs tests/settings-concurrency.integration.test.mjs
```

The fixture suites must run sequentially. See [settings contracts and navigation](docs/SETTINGS.md) for required version fields, 428/409 responses and the branch PUT's updated 200 response.

These tests operate only against a local fixture environment and create uniquely named test branches, schools, accounts and invitations. Preference values and temporary activation changes are restored after testing; test records, captured mail and audit entries remain intentionally visible. Do not run against real school data. Run the suites sequentially, not concurrently, because they share fixture accounts. Allow a minute between authentication-heavy suites to avoid exhausting the local proxy's shared rate-limit window. Recovery tests deliberately exhaust their endpoint limits at the end; allow a minute afterward before testing recovery manually.

```sh
ALLOW_FIXTURE_WRITES=1 node --env-file=.env --test tests/platform.integration.test.mjs
sleep 60
ALLOW_FIXTURE_WRITES=1 node --env-file=.env --test tests/invitations.integration.test.mjs
sleep 60
ALLOW_FIXTURE_WRITES=1 node --env-file=.env --test tests/recovery.integration.test.mjs
sleep 60
ALLOW_FIXTURE_WRITES=1 node --env-file=.env --test tests/mfa.integration.test.mjs
sleep 60
ALLOW_FIXTURE_WRITES=1 node --env-file=.env --test tests/security-storage.integration.test.mjs
sleep 60
ALLOW_FIXTURE_WRITES=1 node --env-file=.env --test tests/outbox.integration.test.mjs
sleep 60
ALLOW_FIXTURE_WRITES=1 node --env-file=.env --test tests/invitation-delivery.integration.test.mjs
sleep 60
ALLOW_FIXTURE_WRITES=1 node --env-file=.env --test tests/history-pagination.integration.test.mjs
docker compose exec -T db psql -U campusnexa -d campusnexa -v ON_ERROR_STOP=1 < tests/database-boundaries.sql
```

Isolated recovery/MFA token and encryption checks use temporary test-only keys (including an isolated restart test) and detached users, without database access:

```sh
dotnet restore tests/RecoveryChecks --locked-mode
dotnet build tests/RecoveryChecks -c Release --no-restore --disable-build-servers -p:UseSharedCompilation=false
dotnet tests/RecoveryChecks/bin/Release/net10.0/RecoveryChecks.dll
```

If the host .NET build stalls, run the same checks in Docker (the check container has no network):

```sh
docker build -f tests/RecoveryChecks/Dockerfile -t campusnexa-security-checks:local .
docker run --rm --network none campusnexa-security-checks:local
```

Browser checks use real authentication and the running Docker stack:

```sh
cd frontend
npm ci
PLAYWRIGHT_BROWSERS_PATH=../.runtime/browsers npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=../.runtime/browsers node --env-file=../.env node_modules/@playwright/test/cli.js test
```

If the host cannot launch Chromium (for example, macOS execution permissions), use the included Linux browser runner from the project root:

```sh
docker compose --profile test run --build --rm e2e
```

This profile downloads a separate browser-testing image on its first run. Screenshots are saved under `.runtime/screenshots`. It is not part of the normal application startup.

Build checks:

```sh
dotnet restore backend/CampusNexa.Api --locked-mode
dotnet build backend/CampusNexa.Api -c Release --no-restore
cd frontend
npm ci
npm run build
```

The Angular CLI persistent cache is disabled because its LMDB native cache crashed on this Mac. Application optimizations and strict template/type checking remain enabled. Tailwind is compiled through PostCSS, not loaded from a CDN. Design tokens and reusable component recipes are in `frontend/src/styles.css`; responsive utilities also appear in the templates. No external fonts or analytics are requested by the app.

Critical-CSS inlining is also disabled: Angular's generated inline stylesheet-loader script conflicts with the nginx Content Security Policy. Stylesheets load directly while the script policy remains restricted. Use the configured Angular parser when formatting `src/app.html`.

See [verification results](docs/VERIFICATION.md) for actual passes and remaining verification gaps.

## Daily Docker commands

```sh
docker compose ps -a
docker compose logs --tail=100 api
docker compose logs --tail=100 migrate
docker compose up --build -d
docker compose stop
```

`stop` retains containers and named volumes. Do not use `down -v` unless you intentionally want to erase the local database and session keys. Database/API ports are not published to the host.

## Backup and restore rehearsal

```sh
node scripts/backup.mjs
node scripts/backup-keys.mjs
node scripts/verify-backup.mjs backups/<file-returned-by-backup>.dump
```

Backups contain all local tenants and identity records. Scripts create owner-only files with SHA-256 manifests; **neither database dumps nor key-ring archives are encrypted**. Encrypt off-device copies and separate access to the database and master-key backups. Earlier snapshots may contain plaintext authenticator secrets. Never commit, share or expose these files.

Restore verification checks the dump manifest, creates a **new, uniquely named database**, verifies expected schema/migration history and security-history triggers when present, reports restored row counts and leaves it for inspection. It never overwrites `campusnexa`. This is a database restore smoke test, not full business-data recovery acceptance. The key archive script copies the existing key ring without displaying its contents; a full application/key-ring restore drill, key rotation/revocation procedure and production point-in-time recovery are still outstanding.

## Repository map

```text
backend/CampusNexa.Api/   ASP.NET Core API, identity, tenancy, EF migrations
frontend/src/            Angular standalone application + Tailwind styling
frontend/e2e/            Browser checks
tests/                  HTTP/PostgreSQL integration suite
scripts/                Local setup, readiness, backup and restore rehearsal
docs/PHASE1.md           Scope, decisions, acceptance and outstanding work
compose.yaml            Local database, migration, API, web and test-mail containers
docs/MAIL.md             Background mail behavior and local operator commands
docs/HISTORY.md          Scoped history pagination, cursor lifetime and API contract
.github/workflows/      CI definition; not yet run on a remote repository
```

The owner supplied [mekalamothish/campusnexa](https://github.com/mekalamothish/campusnexa) for the source repository. This directory is its repository root. The workflow is defined here; actual push/remote CI outcomes are recorded in VERIFICATION.md. No staging or production deployment is available.

Before publication, stage only source and run `node scripts/check-source-safety.mjs`. It rejects tracked local credentials, private/generated paths and detected private-key/token material; it is not a comprehensive secret scanner. Local credentials, backups and runtime files remain ignored.

See [the Phase 1 acceptance checklist](docs/PHASE1-CHECKLIST.md) for its fixed completion gates. Phase 2 remains on hold.

## Before deployment

Do not deploy the supplied development Compose file publicly. It deliberately uses local HTTP, fixture accounts, an unauthenticated local test inbox, a shared development database owner, and development seeding. Production needs TLS, managed secrets, least-privilege database roles, encrypted key storage, trusted proxy configuration, security monitoring, backups with recovery drills, mandatory MFA/recovery policies, production recovery/invitation delivery and validated operator onboarding. See [Phase 1 status and architecture](docs/PHASE1.md).

PostgreSQL has no software licence fee; hosting, storage, backups and operations still cost money. Docker Desktop terms must be reviewed for your organization before commercial use. No software licence has been selected for CampusNexa itself.

## Technical references

- [Tailwind's Angular integration](https://tailwindcss.com/docs/installation/framework-guides/angular)
- [Angular version compatibility](https://angular.dev/reference/versions)
- [Npgsql Entity Framework Core provider](https://www.npgsql.org/efcore/)
- [ASP.NET Core antiforgery](https://learn.microsoft.com/en-us/aspnet/core/security/anti-request-forgery?view=aspnetcore-10.0)
- [Mailpit Docker installation](https://mailpit.axllent.org/docs/install/docker/)
- [ASP.NET Core account confirmation and password recovery](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/accconfirm?view=aspnetcore-10.0)
- [ASP.NET Core MFA](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/mfa?view=aspnetcore-10.0)

Reference links are implementation guidance, not a claim of production certification.
