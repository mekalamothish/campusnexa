# Local mail delivery — P01-M3a / M3b

Implemented 5–6 October 2026. M3a supplies the local PostgreSQL outbox and Mailpit worker; M3b adds school-scoped invitation delivery visibility and controlled failed-delivery replacement. Production email providers and verified sender/domain setup remain open.

## How delivery works

Invitation creation, school onboarding, bootstrap reissue and eligible password-recovery requests save an encrypted MailQueue job in the same database transaction as their domain changes/audit. No SMTP call happens in the web request or onboarding command. A successful request means queued, not delivered.

The separate Compose `worker` process polls every 500 ms. It uses a fixed infrastructure query with `FOR UPDATE SKIP LOCKED` to lock one due job while checking eligibility and submitting SMTP. Queue reads are denied by default. Only the worker/operator context enables full access; the invitation endpoints explicitly opt into read access constrained by validated organization-admin scope, matching tenant and Invitation kind. They project only status, attempts, next-attempt time and completion time. They do not retrieve payloads or recovery jobs, and cannot modify existing jobs. There is no generic browser queue endpoint. Invitation jobs have a composite school/invitation FK and a unique index permitting one job per invitation. Recovery jobs reference an account, not a school.

Each SMTP attempt has a ten-second deadline. Failed attempts retry after 30, 60, 120 and 240 seconds; the fifth failure becomes `Dead`. Recovery exhaustion also records `RecoveryDeliveryFailed` in that user's private history. Queued invitations are not revoked merely because delivery fails. A restarted worker resumes committed pending jobs, and competing workers skip locked rows.

SMTP is **at least once**, not exactly once. If SMTP accepts a message and the worker crashes before recording success, the next attempt can send a duplicate. A stable Message-ID helps identify repeats but cannot require a mail provider to deduplicate. The repeated link has the same single-use invitation/recovery semantics. A process failure before the original domain transaction commits cannot produce a queued email.

## Secrets and stale messages

Recipient, subject, body and recovery security stamp are encrypted with ASP.NET Data Protection, bound to the message ID, kind and school/invitation/account identifiers. Database metadata contains IDs, timestamps, attempt count, state and generic error codes. It never stores raw exception text or plaintext links. The same existing key ring is required after restart/restore; master-key protection remains production work.

Before submission, the worker checks invitation expiry, revocation/acceptance, active school and platform access, or the recovery user's active/confirmed state and security stamp. Expired jobs become `Expired`; invalidated jobs become `Cancelled`; undecryptable jobs become `Dead` with `PayloadUnavailable`. Terminal states clear encrypted message contents. Source state may change after the eligibility check; the actual link endpoint still enforces validity when used. Mailpit contains plaintext captured messages after delivery and remains private/local.

Original deadlines remain unchanged: invitations expire 48 hours after issuance and recovery links 30 minutes after request. Waiting for delivery never renews them. Expired pending jobs are cleared when next processed; a stopped worker performs no cleanup. Retention of terminal metadata, alerts and full disaster-recovery procedures remain to be designed.

## Operator commands

```sh
docker compose ps -a
docker compose logs --tail=50 worker
docker compose run --rm --no-deps api --mail-status
```

Status prints counts grouped by `Pending`, `Sent`, `Dead`, `Expired` and `Cancelled`, without recipients or payloads. It is a trusted local operator command. `Sent` means accepted by local SMTP; it does not prove inbox retention or delivery to a real person. The API readiness endpoint checks the database, not worker progress.

For a pending due job whose ID was obtained through a local operator diagnostic:

```sh
docker compose run --rm --no-deps -e Mail__MessageId=EXACT-JOB-ID api --mail-dispatch-once
```

This respects the job's retry time and terminal state. With no ID it processes at most one due job. It does not revive a `Dead` job. Users can request a new recovery link; organization administrators can use the controlled replacement below. First-administrator recovery remains limited to expired bootstrap invitations because an unfinished school has no signed-in administrator yet.

To resume a stopped worker, run `docker compose up -d worker`. Do not delete database or key volumes. Pending jobs survive container restarts in PostgreSQL. Already delivered Mailpit messages are ephemeral and are not automatically recreated when its inbox is lost.

## School-admin visibility and retry

People & access shows delivery separately from invitation acceptance. History is now cursor-paginated at 25 invitations per UI page; refresh returns to the newest page and Older/Newer navigate history. See HISTORY.md for the envelope/cursor contract. Each invitation retains an optional `delivery` object containing `status`, `attempts`, `nextAttemptAt` (Pending only) and `completedAt`. A null object means no tracked job, including pre-M3a invitations. Timestamps use the browser timezone. A queued/retry time is an earliest eligible time, not a delivery promise. Sent means local SMTP acceptance, not read confirmation. No message ID, recipient payload, token/hash, account ID or internal error detail is included in delivery metadata.

`POST /api/tenants/{tenantId}/invitations/{id}/retry-delivery` requires a currently authenticated organization administrator of that active school, enabled platform access, CSRF and the invitation rate limit. Branch admins/viewers cannot read delivery history or retry. Cross-school IDs return 404. Caller body fields cannot override recipient, scope or deadline.

Only a `Dead` job attached to an unaccepted, unrevoked, unexpired invitation is eligible. Pending jobs retry automatically; Sent, Cancelled, Expired and untracked jobs are refused. Already-member recipients are refused. Because terminal payloads were erased, retry **replaces** the invitation rather than reopening the job: it revokes the old link, creates a fresh random secret with identical recipient/role/branch and **the original expiry**, adds `invitation.delivery-retried` with both invitation IDs and the actor, and queues a new encrypted job. All changes commit together. The original terminal job remains unchanged. Concurrency tokens prevent two successful replacements or acceptance/revocation races; stale requests return 409 and must refresh. There is no automatic HTTP transaction retry.

The UI asks for confirmation before replacement. A delivery failure can be retried again if the replacement itself eventually fails and remains unexpired; there is no chain-wide attempt cap beyond per-job limits, request rate limiting and the preserved deadline. This is not a bulk resend mechanism or a production support bypass. Expired invitations use ordinary new issuance; bootstrap recovery and account password recovery remain separate flows.

## Upgrade and tests

Back up database and key ring, then use `docker compose up --build -d`; migration `20261005045332_MailOutbox` adds MailQueue before worker startup. Existing pre-upgrade invitations do not get retroactive mail jobs because their raw secrets were never stored.

Run suites sequentially as documented in README. The outbox suite temporarily stops only the local worker and restores it afterward. It uses its own fictional invitations/accounts, selected-job dispatchers and a Compose override that makes SMTP unreachable only inside the test dispatcher. It checks actual persisted failure/retry state, not merely a nonzero shell exit. Never run these fixture tests against production data.

The invitation-delivery suite also temporarily stops/restores the worker. It sets terminal states only on new fictional jobs to exercise eligibility, uses a scoped temporary queue-insert trigger to test rollback, and tests real HTTP/SQL concurrency and replacement delivery. Actual SMTP exhaustion remains covered by the outbox suite. Browser coverage includes the real sent-status flow plus a separately labelled mocked-state mobile confirmation test; mocked browser responses are not evidence of backend isolation.

Database restores used for verification remain disconnected from workers. Before a real restoration starts mail workers, review whether pending snapshot jobs could replay mail already sent after that snapshot. This milestone does not claim a completed full application/key-ring recovery drill or a production delivery SLA.
