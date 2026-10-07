using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace CampusNexa.Api.Platform;

public sealed class Invitation : ITenantEntity
{
    public Guid TenantId { get; set; }
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Email { get; set; } = "";
    public string NormalizedEmail { get; set; } = "";
    public string Role { get; set; } = Roles.Viewer;
    public Guid? BranchId { get; set; }
    public string TokenHash { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset ExpiresAt { get; set; } = DateTimeOffset.UtcNow.AddHours(48);
    public DateTimeOffset? AcceptedAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
}

// Deliberately local-only. A reviewed production delivery provider is a later milestone.
public sealed class InvitationMailer(IWebHostEnvironment env, IConfiguration config, PlatformDb db, MailProtection protection)
{
    public bool Available => env.IsDevelopment() && config.GetValue<bool>("Invitations:LocalMailEnabled");
    public void QueueRecovery(AppUser user, string token)
    {
        var origin = config["Invitations:PublicOrigin"] ?? "http://127.0.0.1:4200";
        Queue(new MailOutbox { Kind = "Recovery", UserId = user.Id, ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(30) },
            new MailPayload(user.Email!, "Reset your CampusNexa password",
            $"A password reset was requested for your CampusNexa account.\n\nOpen this link within 30 minutes of your request:\n{origin}/#reset={Uri.EscapeDataString(token)}&email={Uri.EscapeDataString(user.Email!)}\n\nA successful reset signs out all existing sessions across your schools. If you did not request this, ignore this email; nothing has changed. Do not forward this link.\n\nLOCAL TEST EMAIL — not sent to the internet.", user.SecurityStamp));
    }
    public void QueueInvitation(Invitation invite, string token)
    {
        var origin = config["Invitations:PublicOrigin"] ?? "http://127.0.0.1:4200";
        Queue(new MailOutbox { TenantId = invite.TenantId, InvitationId = invite.Id, ExpiresAt = invite.ExpiresAt },
            new MailPayload(invite.Email, "Your CampusNexa invitation",
            $"You have been invited to a CampusNexa workspace as {invite.Role}.\n\nThis single-use link expires at {invite.ExpiresAt:O}:\n{origin}/#invite={token}\n\nExisting users must sign in with the invited email before joining. Do not forward this link.\n\nLOCAL TEST EMAIL — not sent to the internet."));
    }
    private void Queue(MailOutbox job, MailPayload payload)
    {
        if (!Available) throw new InvalidOperationException("Local email delivery is disabled.");
        job.Payload = protection.Protect(job, payload);
        db.MailQueue.Add(job);
    }
    public async Task DeliverAsync(Guid id, MailPayload payload, CancellationToken stop)
    {
        if (!Available) throw new InvalidOperationException("Local email delivery is disabled.");
        using var message = new MailMessage("noreply@campusnexa.test", payload.Email)
        {
            Subject = payload.Subject,
            Body = payload.Body
        };
        using var smtp = new SmtpClient("mail", 1025);
        message.Headers.Add("Message-ID", $"<{id:D}@campusnexa.test>");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        await smtp.SendMailAsync(message, deadline.Token);
    }
}

public static partial class Invitations
{
    public static bool ValidEmail(string? email) => email is { Length: <= 254 } && MailAddress.TryCreate(email, out var parsed) && parsed.Address == email && !email.Contains('\r') && !email.Contains('\n');
    public static (Invitation Invite, string Token) Create(Guid tenant, string email, string role, Guid? branch, UserManager<AppUser> users)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        return (new Invitation { TenantId = tenant, Email = email, NormalizedEmail = users.NormalizeEmail(email), Role = role, BranchId = branch, TokenHash = Hash(token) }, token);
    }
    private static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    private static IResult Invalid() => Results.BadRequest(new { message = "This invitation is invalid, expired or no longer available." });

    // Capability lookup: intentionally bypasses tenant filters only for a 256-bit secret's hash.
    // No tenant supplied by the caller is trusted. Revalidated before every acceptance.
    private static async Task<Invitation?> Resolve(PlatformDb db, string? token)
    {
        if (token is null || !TokenPattern().IsMatch(token)) return null;
        var hash = Hash(token);
        return await db.Invitations.IgnoreQueryFilters().SingleOrDefaultAsync(i => i.TokenHash == hash
            && i.AcceptedAt == null && i.RevokedAt == null && i.ExpiresAt > DateTimeOffset.UtcNow
            && db.Organizations.Any(o => o.Id == i.TenantId && o.IsActive)
            && db.Entitlements.IgnoreQueryFilters().Any(e => e.TenantId == i.TenantId && e.Module == "platform" && e.Enabled));
    }

    public static void MapInvitations(this WebApplication app)
    {
        var group = app.MapGroup("/api/tenants/{tenantId:guid}/invitations").RequireAuthorization().AddEndpointFilter<TenantAccess>();
        group.MapGet("", async (HttpRequest request, PlatformDb db, TenantScope scope, HistoryPaging paging) =>
        {
            if (!scope.AllBranches) return Results.Forbid();
            if (!paging.TryRead(request, "invitations", out var page)) return HistoryPaging.Invalid();
            // Isolation: this opt-in can read only this validated admin's invitation jobs.
            // Project metadata only; never materialize payloads or account recovery jobs.
            db.InvitationDeliveryReadAccess = true;
            var query = db.Invitations.AsNoTracking().Where(i => i.CreatedAt <= page.SnapshotAt);
            if (page.Anchor is { BeforeAt: { } beforeAt, BeforeId: { } beforeId }) query = query.Where(i => EF.Functions.LessThan(
                ValueTuple.Create(i.CreatedAt, i.Id), ValueTuple.Create(beforeAt, beforeId)));
            var rows = await query.OrderByDescending(i => i.CreatedAt).ThenByDescending(i => i.Id).Take(page.PageSize + 1)
                .Select(i => new { i.Id, i.Email, i.Role, i.BranchId, i.CreatedAt, i.ExpiresAt, i.AcceptedAt, i.RevokedAt,
                    Delivery = db.MailQueue.Where(m => m.InvitationId == i.Id)
                        .Select(m => new InvitationDelivery(m.Status, m.Attempts,
                            m.Status == "Pending" ? (DateTimeOffset?)m.AvailableAt : null, m.CompletedAt)).FirstOrDefault()
                }).ToListAsync();
            return Results.Ok(paging.Finish("invitations", page, rows, i => i.CreatedAt, i => i.Id));
        });
        group.MapPost("", async (InviteRequest input, PlatformDb db, TenantScope scope, UserManager<AppUser> users, InvitationMailer mail) =>
        {
            if (!scope.AllBranches) return Results.Forbid();
            if (!mail.Available) return Results.Json(new { message = "Invitation delivery is not configured." }, statusCode: 503);
            var email = input.Email?.Trim() ?? "";
            if (!ValidEmail(email) || input.Role is not (Roles.OrganizationAdmin or Roles.BranchAdmin or Roles.Viewer)
                || (input.Role == Roles.OrganizationAdmin ? input.BranchId != null : input.BranchId == null))
                return Results.BadRequest(new { message = "Choose a valid email, role and branch scope." });
            if (input.BranchId is Guid branch && !await db.Branches.AnyAsync(b => b.Id == branch)) return Results.NotFound();
            var existing = await users.FindByEmailAsync(email);
            if (existing is not null && await db.Memberships.AnyAsync(m => m.TenantId == scope.TenantId && m.UserId == existing.Id))
                return Results.Conflict(new { message = "That email already has a membership in this organization." });
            // Invalidate expired invites so the partial unique index permits a replacement.
            var expired = await db.Invitations.Where(i => i.NormalizedEmail == users.NormalizeEmail(email) && i.AcceptedAt == null && i.RevokedAt == null && i.ExpiresAt <= DateTimeOffset.UtcNow).ToListAsync();
            foreach (var i in expired) { i.RevokedAt = DateTimeOffset.UtcNow; db.Audit("invitation.expired", i.Email, i.BranchId); }
            await db.SaveChangesAsync();
            if (await db.Invitations.AnyAsync(i => i.NormalizedEmail == users.NormalizeEmail(email) && i.AcceptedAt == null && i.RevokedAt == null))
                return Results.Conflict(new { message = "A pending invitation already exists. Revoke it before sending another." });
            var (invite, token) = Create(scope.TenantId, email, input.Role, input.BranchId, users);
            db.Invitations.Add(invite); db.Audit("invitation.created", email, invite.BranchId);
            mail.QueueInvitation(invite, token); await db.SaveChangesAsync();
            return Results.Created($"/api/tenants/{scope.TenantId}/invitations/{invite.Id}", new { invite.Id, invite.Email, invite.ExpiresAt });
        }).RequireRateLimiting("invitations");
        group.MapPost("/{id:guid}/retry-delivery", async (Guid id, PlatformDb db, TenantScope scope, UserManager<AppUser> users, InvitationMailer mail) =>
        {
            if (!scope.AllBranches) return Results.Forbid();
            if (!mail.Available) return Results.Json(new { message = "Invitation delivery is not configured." }, statusCode: 503);
            await using var tx = await db.Database.BeginTransactionAsync();
            var invite = await db.Invitations.SingleOrDefaultAsync(i => i.Id == id);
            if (invite is null) return Results.NotFound();
            if (invite.AcceptedAt != null || invite.RevokedAt != null || invite.ExpiresAt <= DateTimeOffset.UtcNow)
                return Results.Conflict(new { message = "Only an active, unaccepted invitation with failed delivery can be retried. Refresh invitation history." });
            db.InvitationDeliveryReadAccess = true;
            if (!await db.MailQueue.AnyAsync(m => m.InvitationId == id && m.Status == "Dead"))
                return Results.Conflict(new { message = "Delivery has not permanently failed. Pending messages retry automatically; sent messages cannot be retried here." });
            var existing = await users.FindByEmailAsync(invite.Email);
            if (existing is not null && await db.Memberships.AnyAsync(m => m.TenantId == scope.TenantId && m.UserId == existing.Id))
                return Results.Conflict(new { message = "That email already has a membership in this organization." });
            var (replacement, token) = Create(scope.TenantId, invite.Email, invite.Role, invite.BranchId, users);
            replacement.ExpiresAt = invite.ExpiresAt; // Retrying delivery must not extend the access deadline.
            invite.RevokedAt = DateTimeOffset.UtcNow;
            // Concurrency tokens reject simultaneous retries/acceptance/revocation. Release the
            // pending-email unique slot inside this transaction before adding the replacement.
            await db.SaveChangesAsync();
            db.Invitations.Add(replacement);
            db.Audit("invitation.delivery-retried", $"{invite.Id:D} -> {replacement.Id:D}", invite.BranchId);
            mail.QueueInvitation(replacement, token);
            await db.SaveChangesAsync();
            await tx.CommitAsync();
            return Results.Created($"/api/tenants/{scope.TenantId}/invitations/{replacement.Id}",
                new { replacement.Id, replacement.Email, replacement.ExpiresAt, replacedInvitationId = invite.Id });
        }).RequireRateLimiting("invitations");
        group.MapPost("/{id:guid}/revoke", async (Guid id, PlatformDb db, TenantScope scope) =>
        {
            if (!scope.AllBranches) return Results.Forbid();
            var invite = await db.Invitations.SingleOrDefaultAsync(i => i.Id == id);
            if (invite is null) return Results.NotFound();
            if (invite.AcceptedAt != null) return Results.Conflict(new { message = "An accepted invitation cannot be revoked; membership management is a separate operation." });
            if (invite.RevokedAt == null) { invite.RevokedAt = DateTimeOffset.UtcNow; db.Audit("invitation.revoked", invite.Email, invite.BranchId); await db.SaveChangesAsync(); }
            return Results.NoContent();
        });
        app.MapPost("/api/invitations/preview", async (TokenRequest input, PlatformDb db, UserManager<AppUser> users) =>
        {
            var invite = await Resolve(db, input.Token); if (invite is null) return Invalid();
            var org = await db.Organizations.SingleAsync(o => o.Id == invite.TenantId);
            return Results.Ok(new { organization = org.Name, invite.Email, invite.Role, invite.ExpiresAt, requiresSignIn = await users.FindByEmailAsync(invite.Email) != null });
        }).RequireRateLimiting("invitations");
        app.MapPost("/api/invitations/accept", async (AcceptInvite input, HttpContext ctx, PlatformDb db, TenantScope scope, UserManager<AppUser> users) =>
        {
            await using var tx = await db.Database.BeginTransactionAsync();
            var invite = await Resolve(db, input.Token); if (invite is null) return Invalid();
            scope.TenantId = invite.TenantId; scope.Role = Roles.OrganizationAdmin;
            var user = await users.FindByEmailAsync(invite.Email);
            if (user is not null)
            {
                var signedIn = await users.GetUserAsync(ctx.User);
                if (signedIn is null || signedIn.Id != user.Id || !user.IsActive) return Results.Json(new { message = "Sign in with the invited email before accepting this invitation." }, statusCode: 403);
            }
            else
            {
                if (ctx.User.Identity?.IsAuthenticated == true) return Results.Conflict(new { message = "Sign out before creating the invited account." });
                if (string.IsNullOrWhiteSpace(input.DisplayName) || input.DisplayName.Trim().Length > 120 || input.Password is null || input.Password.Length > 256)
                    return Results.BadRequest(new { message = "Enter a name and a password of at least 12 characters with upper/lower case, a number and symbol." });
                user = new AppUser { Id = Guid.NewGuid(), UserName = invite.Email, Email = invite.Email, DisplayName = input.DisplayName.Trim(), EmailConfirmed = true };
                var created = await users.CreateAsync(user, input.Password);
                if (!created.Succeeded) return Results.BadRequest(new { message = "Account creation failed. Use a password of at least 12 characters with upper/lower case, a number and symbol, or sign in if this account already exists." });
            }
            if (await db.Memberships.AnyAsync(m => m.TenantId == invite.TenantId && m.UserId == user.Id)) return Results.Conflict(new { message = "This account already belongs to the organization." });
            scope.UserId = user.Id;
            db.Memberships.Add(new Membership { TenantId = invite.TenantId, UserId = user.Id, Role = invite.Role, BranchId = invite.BranchId });
            invite.AcceptedAt = DateTimeOffset.UtcNow;
            db.Audit("invitation.accepted", invite.Email, invite.BranchId);
            await db.SaveChangesAsync(); await tx.CommitAsync();
            return Results.Ok(new { message = "Invitation accepted. Sign in to open your workspace.", tenantId = invite.TenantId });
        }).RequireRateLimiting("invitations");
    }

    public static async Task OnboardAsync(IServiceProvider services, IConfiguration config)
    {
        var mail = services.GetRequiredService<InvitationMailer>();
        if (!mail.Available) throw new InvalidOperationException("This milestone's onboarding command is local-development only.");
        var name = config["Onboard:Name"]?.Trim() ?? "";
        var slug = config["Onboard:Slug"]?.Trim() ?? "";
        var email = config["Onboard:Email"]?.Trim() ?? "";
        if (name.Length is < 1 or > 120 || !SlugPattern().IsMatch(slug) || !ValidEmail(email)) throw new InvalidOperationException("Set Onboard__Name (1–120), Onboard__Slug (3–60 lowercase letters/numbers/hyphens), and Onboard__Email.");
        var db = services.GetRequiredService<PlatformDb>(); var scope = services.GetRequiredService<TenantScope>();
        if (await db.Organizations.AnyAsync(o => o.Slug == slug)) throw new InvalidOperationException("Organization slug already exists; nothing changed.");
        await using var tx = await db.Database.BeginTransactionAsync();
        var id = Guid.NewGuid(); scope.TenantId = id; scope.Role = Roles.OrganizationAdmin;
        db.Organizations.Add(new Organization { Id = id, Name = name, Slug = slug });
        db.Branches.Add(new Branch { TenantId = id, Name = "Main Campus", Code = "MAIN" });
        db.Settings.Add(new TenantSettings { TenantId = id, DisplayName = name });
        foreach (var module in new[] { "platform", "academics", "finance", "communication", "campus", "reports" }) db.Entitlements.Add(new ModuleEntitlement { TenantId = id, Module = module, Enabled = module == "platform" });
        var (invite, token) = Create(id, email, Roles.OrganizationAdmin, null, services.GetRequiredService<UserManager<AppUser>>());
        db.Invitations.Add(invite); db.Audit("organization.onboarded", name); db.Audit("invitation.created", email);
        mail.QueueInvitation(invite, token);
        await db.SaveChangesAsync(); await tx.CommitAsync();
        Console.WriteLine($"Created organization {id}. Administrator invitation queued for the local mail inbox.");
    }
    [GeneratedRegex("^[A-F0-9]{64}$")] private static partial Regex TokenPattern();
    [GeneratedRegex("^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$")] private static partial Regex SlugPattern();
}
public sealed record InviteRequest(string Email, string Role, Guid? BranchId);
public sealed record InvitationDelivery(string Status, int Attempts, DateTimeOffset? NextAttemptAt, DateTimeOffset? CompletedAt);
public sealed record TokenRequest(string Token);
public sealed record AcceptInvite(string Token, string? DisplayName, string? Password);
