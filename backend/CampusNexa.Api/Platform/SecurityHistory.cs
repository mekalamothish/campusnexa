using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace CampusNexa.Api.Platform;

public enum SecurityAction
{
    PasswordSignIn, SignInFailed, MfaChallengeStarted, MfaSignIn, RecoveryCodeSignIn,
    MfaVerificationFailed, MfaSetupStarted, MfaEnabled, MfaDisabled, RecoveryCodesReplaced,
    MfaManagementFailed, PasswordRecoveryRequested, RecoveryDeliveryFailed, PasswordReset,
    PasswordResetFailed, SignedOut, SessionsRevoked, AuthenticatorKeyProtected
}

// Identity/account-global, deliberately separate from tenant-visible business audit.
// No free-text payload, email, IP, credential, token, setup key or recovery code.
public sealed class SecurityEvent
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid UserId { get; set; }
    public SecurityAction Action { get; set; }
    public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow;
}

public static class SecurityHistory
{
    public static void MapSecurityHistory(this WebApplication app)
    {
        app.MapGet("/api/auth/security-events", async (HttpContext ctx, PlatformDb db, UserManager<AppUser> users) =>
        {
            var user = (await users.GetUserAsync(ctx.User))!;
            db.SecurityReaderId = user.Id; // Only validated current identity, never a request parameter.
            return Results.Ok(await db.SecurityEvents.AsNoTracking().OrderByDescending(e => e.OccurredAt).ThenByDescending(e => e.Id)
                .Take(100).Select(e => new { e.Id, action = e.Action.ToString(), e.OccurredAt }).ToListAsync());
        }).RequireAuthorization();
    }
}
