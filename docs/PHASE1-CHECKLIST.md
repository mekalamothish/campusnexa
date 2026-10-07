# Phase 1 acceptance checklist

Updated 6 October 2026. Phase 2 is on hold at the product owner's request. **Phase 1 is not yet accepted.** This checklist preserves the original six Phase 1 packages; completing a local milestone is not approval of the whole phase.

The original plan requires isolation/access tests, a staging deployment, monitoring and restore evidence. A successful local Docker build alone cannot satisfy that exit.

## Completed locally

- [x] Angular/Tailwind and ASP.NET Core projects, locked dependencies, Docker and versioned PostgreSQL migrations.
- [x] Validated school/branch memberships and negative tenant/branch isolation tests for implemented features.
- [x] Login, logout/session revocation, local invitations, password recovery and optional authenticator MFA.
- [x] Organization defaults, branch overrides, inheritance and server-side module entitlement checks.
- [x] Conflict-safe settings saves with retained drafts and explicit reload, including simultaneous-write tests.
- [x] Transactional business audit, database append-only guards and account-private security history.
- [x] Encrypted transactional local mail queue, bounded retries and controlled invitation retry.
- [x] Responsive workspace, scoped invitation/activity pagination and supported page URLs with Back/Forward.
- [x] Database backup and isolated database restore tooling, local readiness checks and automated verification.

Verification details and limitations are in VERIFICATION.md. Checkmarks describe the local scope, not production approval.

## Original package completion gates still open

| Package | Remaining implementation or acceptance work |
| --- | --- |
| P01-T01 Repositories and delivery | Publish and verify the GitHub workflow; define staging and secret handling; configure required checks/protection and prove failed checks block promotion. |
| P01-T02 Tenant and branch boundaries | Extend the existing isolation guarantees to the shared file service and every new infrastructure path. Validate the agreed school/tenant structure for onboarding. |
| P01-T03 Identity and permissions | Configurable permissions; approved MFA and lost-factor policy; real email ownership/delivery verification; production onboarding/recovery and protected master keys. |
| P01-T04 Settings and entitlements | Complete the agreed branding, academic-period and numbering settings beyond the current display name/year label. Specify formats and period rules before implementing them. Paid subscription billing is not this phase's gate. |
| P01-T05 Shared services | Private tenant/branch-scoped file metadata/storage and access tests; upload validation/quarantine/scanning; reusable retry/idempotency conventions and provider-backed notification verification. |
| P01-T06 Shell and operations | Remove remaining directory/security-history caps, complete keyboard/accessibility acceptance, scoped metrics/alerts, production-like staging and an application/key recovery drill with agreed recovery targets. |

The broader PHASE1.md retains all known platform work. Its references to SSO/passkeys, dedicated databases, full translation, paid billing, school imports/exports and mobile authentication are future requirements, not new additions to the original Phase 1 exit. They must not keep expanding this phase indefinitely.

## Decisions and external access

- GitHub repository supplied by the owner: https://github.com/mekalamothish/campusnexa. Initial source publication has been authorized. Track the actual commit/push/CI outcome in VERIFICATION.md.
- No staging server/cloud account has been supplied. Do not buy infrastructure, create a public deployment, or describe the local stack as staging.
- Email provider/sender details have not been supplied; Mailpit remains a local test inbox.
- Required administrator MFA and lost-all-factors recovery remain unapproved. Optional MFA stays unchanged until a policy is agreed.
- Confirm tenant/school meaning, basic academic-period/numbering rules, required branding, launch scale, recovery objectives and data retention before their acceptance.

## Sign-off

Before closing Phase 1, map each remaining gate above to passing tests or recorded owner approval, link the staging/recovery evidence, and record the exact accepted release commit. Do not mark items complete because a later phase needs them. Do not move unfinished requirements to Phase 11 without explicit agreement.
