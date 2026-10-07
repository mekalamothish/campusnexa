using System.Data;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace CampusNexa.Api.Platform;

// Trusted local CLI only. No HTTP route and no authority to recover an established school.
public static class BootstrapRecovery
{
    public static async Task RunAsync(IServiceProvider services, IConfiguration config, bool reissue)
    {
        var mail = services.GetRequiredService<InvitationMailer>();
        if (!mail.Available) throw new InvalidOperationException("Bootstrap recovery requires Development and local mail delivery.");
        var slug = config["Bootstrap:Slug"]?.Trim();
        if (string.IsNullOrEmpty(slug) || slug.Length > 60)
            throw new InvalidOperationException("Set Bootstrap__Slug to the exact school slug.");
        Guid expected = default;
        if (reissue && !Guid.TryParse(config["Bootstrap:InvitationId"], out expected))
            throw new InvalidOperationException("Set Bootstrap__InvitationId from --bootstrap-status.");

        var db = services.GetRequiredService<PlatformDb>();
        var scope = services.GetRequiredService<TenantScope>();
        // Serializable protects eligibility reads; replacement and mail job commit together.
        await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable);
        var org = await db.Organizations.SingleOrDefaultAsync(o => o.Slug == slug)
            ?? throw new InvalidOperationException("School slug was not found.");
        scope.TenantId = org.Id;
        scope.Role = Roles.OrganizationAdmin;
        var pending = await db.Invitations.Where(i => i.AcceptedAt == null && i.RevokedAt == null).Take(2).ToListAsync();
        var invite = pending.Count == 1 ? pending[0] : null;
        var reason = !org.IsActive ? "School is inactive."
            : !await db.Entitlements.AnyAsync(e => e.Module == "platform" && e.Enabled) ? "Platform access is disabled."
            : await db.Memberships.AnyAsync(m => m.TenantId == org.Id) ? "School already has membership history; use its administrator workflow."
            : !await db.AuditEvents.AnyAsync(a => a.Action == "organization.onboarded") ? "School was not created by local onboarding."
            : invite is null ? "Exactly one unaccepted, unrevoked bootstrap invitation is required."
            : invite.Role != Roles.OrganizationAdmin || invite.BranchId != null ? "Invitation is not for the initial organization administrator."
            : await db.Invitations.AnyAsync(i => i.AcceptedAt != null || i.NormalizedEmail != invite.NormalizedEmail || i.Role != Roles.OrganizationAdmin || i.BranchId != null) ? "Invitation history is not an unfinished bootstrap sequence."
            : invite.ExpiresAt > DateTimeOffset.UtcNow ? "Invitation has not expired; use its existing link."
            : null;

        if (!reissue)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { organizationId = org.Id, slug = org.Slug,
                invitationId = invite?.Id, email = invite?.Email, expiresAt = invite?.ExpiresAt,
                eligible = reason is null, reason }));
            await tx.CommitAsync();
            return;
        }
        if (reason is not null) throw new InvalidOperationException(reason);
        if (invite!.Id != expected) throw new InvalidOperationException("Invitation ID does not match the current bootstrap invitation; inspect status again.");

        invite.RevokedAt = DateTimeOffset.UtcNow;
        var (replacement, token) = Invitations.Create(org.Id, invite.Email, Roles.OrganizationAdmin, null,
            services.GetRequiredService<UserManager<AppUser>>());
        // Flush revocation before inserting, to release the pending-email unique index slot.
        await db.SaveChangesAsync();
        db.Invitations.Add(replacement);
        db.Audit("invitation.bootstrap-reissued", $"{invite.Id:D} -> {replacement.Id:D}");
        mail.QueueInvitation(replacement, token);
        await db.SaveChangesAsync();
        await tx.CommitAsync();
        Console.WriteLine(JsonSerializer.Serialize(new { organizationId = org.Id, invitationId = replacement.Id,
            expiresAt = replacement.ExpiresAt, message = "Replacement queued for the original recipient in the local inbox." }));
    }
}
