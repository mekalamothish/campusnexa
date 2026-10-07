-- Read existing fixtures, attempt invalid mutations, roll everything back.
-- Run only on the seeded local database with ON_ERROR_STOP=1.
BEGIN;
DO $$
DECLARE
    alpha uuid := '11111111-1111-1111-1111-111111111111';
    beta uuid := '22222222-2222-2222-2222-222222222222';
    foreign_branch uuid;
    viewer_id uuid;
    event_id uuid := gen_random_uuid();
    audit_id uuid := gen_random_uuid();
    invitation_id uuid := gen_random_uuid();
    mail_id uuid := gen_random_uuid();
BEGIN
    SELECT "Id" INTO STRICT foreign_branch FROM "Branches" WHERE "TenantId" = beta AND "Code" = 'MAIN';
    SELECT "Id" INTO STRICT viewer_id FROM "AspNetUsers" WHERE "Email" = 'viewer@campusnexa.test';
    INSERT INTO "AuditEvents" ("TenantId","Id","ActorId","Action","Subject","OccurredAt")
    VALUES (alpha,audit_id,viewer_id,'test.rollback','Transactional constraint test',now());
    BEGIN
        UPDATE "AuditEvents" SET "Subject"='altered' WHERE "TenantId"=alpha AND "Id"=audit_id;
        RAISE EXCEPTION 'FAIL: audit update accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN RAISE NOTICE 'PASS: audit updates rejected'; END;
    BEGIN
        DELETE FROM "AuditEvents" WHERE "TenantId"=alpha AND "Id"=audit_id;
        RAISE EXCEPTION 'FAIL: audit delete accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN RAISE NOTICE 'PASS: audit deletes rejected'; END;
    BEGIN
        TRUNCATE "AuditEvents";
        RAISE EXCEPTION 'FAIL: audit truncate accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN RAISE NOTICE 'PASS: audit truncate rejected'; END;
    INSERT INTO "Invitations" ("TenantId","Id","Email","NormalizedEmail","Role","TokenHash","CreatedAt","ExpiresAt")
    VALUES (alpha,invitation_id,'mail-constraint@campusnexa.test','MAIL-CONSTRAINT@CAMPUSNEXA.TEST','OrganizationAdmin',repeat('A',64),now(),now()+interval '1 hour');
    INSERT INTO "MailQueue" ("Id","TenantId","InvitationId","Kind","Payload","Status","Attempts","CreatedAt","AvailableAt","ExpiresAt")
    VALUES (mail_id,alpha,invitation_id,'Invitation','test-only','Pending',0,now(),now(),now()+interval '1 hour');
    BEGIN
        UPDATE "MailQueue" SET "TenantId"=beta WHERE "Id"=mail_id;
        RAISE EXCEPTION 'FAIL: foreign-tenant mail accepted';
    EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: mail invitation tenant FK enforced'; END;
    BEGIN
        UPDATE "MailQueue" SET "UserId"=viewer_id WHERE "Id"=mail_id;
        RAISE EXCEPTION 'FAIL: mixed mail scope accepted';
    EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: mail scope check enforced'; END;
    BEGIN
        UPDATE "MailQueue" SET "Attempts"=6 WHERE "Id"=mail_id;
        RAISE EXCEPTION 'FAIL: unbounded attempts accepted';
    EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: mail attempts bounded'; END;
    BEGIN
        INSERT INTO "MailQueue" ("Id","TenantId","InvitationId","Kind","Payload","Status","Attempts","CreatedAt","AvailableAt","ExpiresAt")
        VALUES (gen_random_uuid(),alpha,invitation_id,'Invitation','duplicate','Pending',0,now(),now(),now()+interval '1 hour');
        RAISE EXCEPTION 'FAIL: duplicate invitation mail accepted';
    EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: one job per invitation enforced'; END;
    INSERT INTO "SecurityEvents" ("Id","UserId","Action","OccurredAt") VALUES (event_id,viewer_id,'PasswordSignIn',now());
    BEGIN
        UPDATE "SecurityEvents" SET "Action"='SignedOut' WHERE "Id"=event_id;
        RAISE EXCEPTION 'FAIL: security event update accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN RAISE NOTICE 'PASS: security event updates rejected'; END;
    BEGIN
        DELETE FROM "SecurityEvents" WHERE "Id"=event_id;
        RAISE EXCEPTION 'FAIL: security event delete accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN RAISE NOTICE 'PASS: security event deletes rejected'; END;
    BEGIN
        TRUNCATE "SecurityEvents";
        RAISE EXCEPTION 'FAIL: security event truncate accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN RAISE NOTICE 'PASS: security event truncate rejected'; END;
    BEGIN
        INSERT INTO "SecurityEvents" ("Id","UserId","Action","OccurredAt") VALUES (gen_random_uuid(),viewer_id,'secret-freeform',now());
        RAISE EXCEPTION 'FAIL: arbitrary security event accepted';
    EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: security action allowlist enforced'; END;
    BEGIN
        UPDATE "Memberships" SET "BranchId" = foreign_branch WHERE "TenantId" = alpha AND "UserId" = viewer_id;
        RAISE EXCEPTION 'FAIL: cross-tenant branch membership was accepted';
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'PASS: composite FK rejects cross-tenant branch membership';
    END;
    BEGIN
        UPDATE "Memberships" SET "Role" = 'UnknownSuperAdmin' WHERE "TenantId" = alpha AND "UserId" = viewer_id;
        RAISE EXCEPTION 'FAIL: unknown role was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS: role check rejects unknown roles';
    END;
    BEGIN
        UPDATE "Memberships" SET "BranchId" = NULL WHERE "TenantId" = alpha AND "UserId" = viewer_id;
        RAISE EXCEPTION 'FAIL: branch-scoped role without a branch was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS: branch-scoped membership requires a branch';
    END;
    BEGIN
        INSERT INTO "Branches" ("TenantId", "Id", "Name", "Code", "CreatedAt")
        VALUES (alpha, gen_random_uuid(), 'Must roll back', 'MAIN', now());
        RAISE EXCEPTION 'FAIL: duplicate branch code was accepted';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'PASS: database uniqueness rejects duplicate codes within a tenant';
    END;
    BEGIN
        INSERT INTO "Invitations" ("TenantId", "Id", "Email", "NormalizedEmail", "Role", "BranchId", "TokenHash", "CreatedAt", "ExpiresAt")
        VALUES (alpha, gen_random_uuid(), 'constraint@campusnexa.test', 'CONSTRAINT@CAMPUSNEXA.TEST', 'Viewer', foreign_branch, repeat('0',64), now(), now()+interval '1 hour');
        RAISE EXCEPTION 'FAIL: cross-tenant invitation branch was accepted';
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'PASS: invitation composite FK rejects cross-tenant branches';
    END;
    BEGIN
        INSERT INTO "Invitations" ("TenantId", "Id", "Email", "NormalizedEmail", "Role", "BranchId", "TokenHash", "CreatedAt", "ExpiresAt")
        VALUES (alpha, gen_random_uuid(), 'constraint@campusnexa.test', 'CONSTRAINT@CAMPUSNEXA.TEST', 'RootAdmin', NULL, repeat('1',64), now(), now()+interval '1 hour');
        RAISE EXCEPTION 'FAIL: invalid invitation role was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS: invitation role constraint rejects invalid scope';
    END;
END $$;
ROLLBACK;
