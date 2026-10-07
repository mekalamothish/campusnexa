using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.WebUtilities;

namespace CampusNexa.Api.Platform;

// Separate purpose and lifetime; invitation links and other Identity tokens are unaffected.
public sealed class RecoveryTokenProvider(
    IDataProtectionProvider protection, ILogger<DataProtectorTokenProvider<AppUser>> logger)
    : DataProtectorTokenProvider<AppUser>(protection,
        Microsoft.Extensions.Options.Options.Create(new DataProtectionTokenProviderOptions
        { Name = "CampusNexa.PasswordRecovery.v1", TokenLifespan = TimeSpan.FromMinutes(30) }), logger);

public static class Recovery
{
    private const string Acknowledgement = "If an eligible account exists, a recovery link will arrive in the local test inbox. Check the inbox or try again later.";
    private static IResult InvalidLink() => Results.BadRequest(new { message = "This recovery link is invalid, expired or already used. Request a new link." });

    public static void MapRecovery(this WebApplication app)
    {
        app.MapPost("/api/auth/forgot-password", async (ForgotPassword input, UserManager<AppUser> users, InvitationMailer mail, PlatformDb db) =>
        {
            // Availability is independent of the supplied account. Never disclose account existence.
            if (!mail.Available) return Results.Json(new { message = "Local recovery is not enabled." }, statusCode: 503);
            var email = input.Email?.Trim() ?? "";
            if (Invitations.ValidEmail(email))
            {
                var user = await users.FindByEmailAsync(email);
                if (user is { IsActive: true, EmailConfirmed: true })
                {
                    var token = await users.GeneratePasswordResetTokenAsync(user);
                    var code = WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(token));
                    mail.QueueRecovery(user, code);
                    await db.RecordSecurity(user.Id, SecurityAction.PasswordRecoveryRequested);
                }
            }
            return Results.Ok(new { message = Acknowledgement });
        }).RequireRateLimiting("recovery-request");

        app.MapPost("/api/auth/reset-password", async (ResetPassword input, UserManager<AppUser> users, InvitationMailer mail, SignInManager<AppUser> signIn, ILoggerFactory logs, PlatformDb db) =>
        {
            if (!mail.Available) return Results.Json(new { message = "Local recovery is not enabled." }, statusCode: 503);
            if (!Invitations.ValidEmail(input.Email) || input.Token is not { Length: > 0 and <= 4096 }) return InvalidLink();
            if (input.Password is not { Length: >= 12 and <= 256 })
                return Results.BadRequest(new { message = "Use a password of 12–256 characters with upper/lower case, a number and a symbol." });
            string token;
            try { token = Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(input.Token)); }
            catch (FormatException) { return InvalidLink(); }
            await using var tx = await db.Database.BeginTransactionAsync();
            var user = await users.FindByEmailAsync(input.Email!);
            if (user is not { IsActive: true, EmailConfirmed: true }) return InvalidLink();
            // Account-global operation, not tenant administration: no membership/role fields are read or written.
            // Identity validates purpose, age and security stamp, then updates password + stamp using
            // its optimistic concurrency check. Successful reset invalidates all prior links and sessions.
            var result = await users.ResetPasswordAsync(user, token, input.Password);
            if (!result.Succeeded)
            {
                // Concurrency failure can leave modified tracked identity state. Never save it
                // just to record a failure; roll back and record after clearing that state.
                await tx.RollbackAsync(); db.ChangeTracker.Clear();
                await db.RecordSecurity(user.Id, SecurityAction.PasswordResetFailed);
                if (result.Errors.Any(e => e.Code.StartsWith("Password", StringComparison.Ordinal)))
                    return Results.BadRequest(new { message = "Use a password of 12–256 characters with upper/lower case, a number and a symbol." });
                return InvalidLink();
            }
            await db.RecordSecurity(user.Id, SecurityAction.PasswordReset); await tx.CommitAsync();
            await signIn.SignOutAsync();
            logs.CreateLogger("Recovery").LogInformation("Password reset completed for account {AccountId}; prior sessions invalidated.", user.Id);
            return Results.Ok(new { message = "Password updated. Sign in with your new password. Existing sessions have been signed out." });
        }).RequireRateLimiting("recovery-reset");
    }
}

public sealed record ForgotPassword(string? Email);
public sealed record ResetPassword(string? Email, string? Token, string? Password);
