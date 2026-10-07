# CampusNexa project guidance

Read README.md and docs/PHASE1.md before extending this project. Record completed work and actual verification evidence in docs/VERIFICATION.md. The current milestone is a platform foundation, not a complete ERP.

- Use Angular + Tailwind CSS, ASP.NET Core and PostgreSQL. Do not introduce a second database provider or switch UI frameworks without approval.
- Tenant IDs and branch scope must come from validated memberships, never trusted client headers/body fields. Add negative cross-tenant and cross-branch tests for each new feature.
- Keep tenant-aware keys/FKs and write guards. Do not bypass EF filters or use raw SQL in application endpoints without an explicitly reviewed isolation design.
- Keep cookies HttpOnly and require CSRF for browser mutations. Do not place credentials or tokens in localStorage. Never commit .env, backups or runtime state.
- Only use fictional fixtures in development. Do not activate seed mode in production, invent compliance claims or label planned modules as implemented.
- Use Tailwind tokens/utilities and component recipes in frontend/src/styles.css. Preserve responsive behavior and keyboard access.
- Keep migration changes additive/reviewable. Never erase volumes or reset an existing database to make tests pass.
- Run the production build, integration suite, SQL constraints and browser suite relevant to the change. Follow README commands; Docker E2E is available if the host cannot launch Chromium.
- Update the phase record honestly: unimplemented onboarding, MFA, delivery jobs and production hardening must stay visible until implemented and tested.
