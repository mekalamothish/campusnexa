using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace CampusNexa.Api.Platform;

// Account-scoped Identity state. Never accepts a tenant, role, branch or target user from callers.
public sealed class MfaService(UserManager<AppUser> users, IDataProtectionProvider protection, IWebHostEnvironment env)
{
    private const string Provider = "CampusNexaMfa";
    private const string Cookie = "CampusNexa.MfaChallenge";
    private readonly ITimeLimitedDataProtector protector = protection.CreateProtector("CampusNexa.MfaChallenge.v1").ToTimeLimitedDataProtector();
    private sealed record Challenge(string UserId, string Stamp, string Nonce);
    private sealed record UsedCode(string Hash, DateTimeOffset Until);
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    public static void Check(IdentityResult result)
    {
        if (!result.Succeeded) throw new DbUpdateConcurrencyException("Identity state changed; retry the operation.");
    }
    private Task<string?> Get(AppUser user, string name) => users.GetAuthenticationTokenAsync(user, Provider, name);
    private async Task Set(AppUser user, string name, string value) => Check(await users.SetAuthenticationTokenAsync(user, Provider, name, value));
    private CookieOptions CookieOptions(HttpContext ctx) => new() { HttpOnly = true, Secure = !env.IsDevelopment() || ctx.Request.IsHttps, SameSite = SameSiteMode.Strict, Path = "/api/auth/mfa", MaxAge = TimeSpan.FromMinutes(5), IsEssential = true };
    public void Clear(HttpContext ctx) => ctx.Response.Cookies.Delete(Cookie, CookieOptions(ctx));
    public async Task Issue(AppUser user, HttpContext ctx)
    {
        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        await Set(user, "Challenge", Hash(nonce));
        var payload = new Challenge(user.Id.ToString(), user.SecurityStamp!, nonce);
        ctx.Response.Cookies.Append(Cookie, protector.Protect(JsonSerializer.Serialize(payload), TimeSpan.FromMinutes(5)), CookieOptions(ctx));
    }
    public async Task<AppUser?> Resolve(HttpContext ctx)
    {
        if (!ctx.Request.Cookies.TryGetValue(Cookie, out var value) || value.Length > 4096) return null;
        Challenge? challenge;
        try { challenge = JsonSerializer.Deserialize<Challenge>(protector.Unprotect(value)); }
        catch (Exception e) when (e is CryptographicException or JsonException or FormatException) { return null; }
        if (challenge is null) return null;
        var user = await users.FindByIdAsync(challenge.UserId);
        if (user is not { IsActive: true, EmailConfirmed: true, TwoFactorEnabled: true }
            || user.SecurityStamp != challenge.Stamp || await users.IsLockedOutAsync(user)
            || await Get(user, "Challenge") != Hash(challenge.Nonce)) return null;
        return user;
    }
    public async Task ConsumeChallenge(AppUser user) => Check(await users.RemoveAuthenticationTokenAsync(user, Provider, "Challenge"));
    public async Task<string[]> Codes(AppUser user)
    {
        var codes = Enumerable.Range(0, 10).Select(_ => Convert.ToHexString(RandomNumberGenerator.GetBytes(16))).ToArray();
        await Set(user, "RecoveryHashes", JsonSerializer.Serialize(codes.Select(Hash)));
        return codes;
    }
    public async Task<int> Count(AppUser user) => (JsonSerializer.Deserialize<string[]>(await Get(user, "RecoveryHashes") ?? "[]") ?? []).Length;
    public async Task<bool> Verify(AppUser user, string? code, bool recovery)
    {
        if (code is null || code.Length > 100) return false;
        code = code.Replace(" ", "").Replace("-", "");
        if (recovery)
        {
            var hashes = (JsonSerializer.Deserialize<List<string>>(await Get(user, "RecoveryHashes") ?? "[]") ?? []);
            if (!hashes.Remove(Hash(code.ToUpperInvariant()))) return false;
            await Set(user, "RecoveryHashes", JsonSerializer.Serialize(hashes));
            return true;
        }
        if (code.Length != 6 || code.Any(c => c is < '0' or > '9')
            || !await users.VerifyTwoFactorTokenAsync(user, users.Options.Tokens.AuthenticatorTokenProvider, code)) return false;
        var used = (JsonSerializer.Deserialize<List<UsedCode>>(await Get(user, "UsedTotp") ?? "[]") ?? [])
            .Where(x => x.Until > DateTimeOffset.UtcNow).ToList();
        if (used.Any(x => x.Hash == Hash(code))) return false;
        used.Add(new UsedCode(Hash(code), DateTimeOffset.UtcNow.AddMinutes(5)));
        await Set(user, "UsedTotp", JsonSerializer.Serialize(used));
        return true;
    }
    public async Task ClearRecovery(AppUser user) => await Set(user, "RecoveryHashes", "[]");
}

public static class MfaEndpoints
{
    private static IResult Invalid() => Results.BadRequest(new { message = "Unable to verify. Check your password/code, wait for a new authenticator code, or restart sign-in if the challenge expired." });
    public static void MapMfa(this WebApplication app)
    {
        app.MapPost("/api/auth/mfa/verify", async (MfaProof input, HttpContext ctx, PlatformDb db, MfaService mfa, UserManager<AppUser> users, SignInManager<AppUser> signIn) =>
        {
            await using var tx = await db.Database.BeginTransactionAsync();
            var user = await mfa.Resolve(ctx);
            if (user is null) { mfa.Clear(ctx); return Invalid(); }
            if (!await mfa.Verify(user, input.Code, input.Recovery))
            {
                MfaService.Check(await users.AccessFailedAsync(user)); await db.RecordSecurity(user.Id, SecurityAction.MfaVerificationFailed); await tx.CommitAsync(); return Invalid();
            }
            await mfa.ConsumeChallenge(user);
            MfaService.Check(await users.ResetAccessFailedCountAsync(user));
            await db.RecordSecurity(user.Id, input.Recovery ? SecurityAction.RecoveryCodeSignIn : SecurityAction.MfaSignIn);
            await tx.CommitAsync();
            mfa.Clear(ctx);
            await signIn.SignInAsync(user, false, "mfa");
            return Results.NoContent();
        }).RequireRateLimiting("mfa");

        var group = app.MapGroup("/api/auth/mfa").RequireAuthorization().RequireRateLimiting("mfa");
        group.MapGet("/status", async (HttpContext ctx, UserManager<AppUser> users, MfaService mfa) =>
        {
            var user = (await users.GetUserAsync(ctx.User))!;
            return Results.Ok(new { enabled = user.TwoFactorEnabled, recoveryCodesRemaining = await mfa.Count(user) });
        });
        group.MapPost("/setup", async (MfaProof input, HttpContext ctx, PlatformDb db, UserManager<AppUser> users, SignInManager<AppUser> signIn) =>
        {
            await using var tx = await db.Database.BeginTransactionAsync();
            var user = (await users.GetUserAsync(ctx.User))!;
            if (user.TwoFactorEnabled) return Results.Conflict(new { message = "MFA is already enabled. Disable it before replacing your authenticator." });
            if (!await Password(user, input.Password, users)) { await db.RecordSecurity(user.Id, SecurityAction.MfaManagementFailed); await tx.CommitAsync(); return Invalid(); }
            MfaService.Check(await users.ResetAuthenticatorKeyAsync(user));
            MfaService.Check(await users.ResetAccessFailedCountAsync(user));
            var key = await users.GetAuthenticatorKeyAsync(user);
            await db.RecordSecurity(user.Id, SecurityAction.MfaSetupStarted);
            await tx.CommitAsync(); await signIn.RefreshSignInAsync(user);
            return Results.Ok(new { sharedKey = key, issuer = "CampusNexa", account = user.Email });
        });
        group.MapPost("/enable", async (MfaProof input, HttpContext ctx, PlatformDb db, UserManager<AppUser> users, SignInManager<AppUser> signIn, MfaService mfa) =>
        {
            await using var tx = await db.Database.BeginTransactionAsync();
            var user = (await users.GetUserAsync(ctx.User))!;
            if (user.TwoFactorEnabled) return Results.Conflict(new { message = "MFA is already enabled." });
            if (!await Password(user, input.Password, users)) { await db.RecordSecurity(user.Id, SecurityAction.MfaManagementFailed); await tx.CommitAsync(); return Invalid(); }
            if (!await mfa.Verify(user, input.Code, false)) { MfaService.Check(await users.AccessFailedAsync(user)); await db.RecordSecurity(user.Id, SecurityAction.MfaManagementFailed); await tx.CommitAsync(); return Invalid(); }
            MfaService.Check(await users.SetTwoFactorEnabledAsync(user, true));
            var codes = await mfa.Codes(user);
            MfaService.Check(await users.ResetAccessFailedCountAsync(user));
            MfaService.Check(await users.UpdateSecurityStampAsync(user));
            await db.RecordSecurity(user.Id, SecurityAction.MfaEnabled);
            await tx.CommitAsync(); await signIn.RefreshSignInAsync(user);
            return Results.Ok(new { recoveryCodes = codes });
        });
        foreach (var action in new[] { "disable", "recovery-codes" })
        {
            group.MapPost("/" + action, async (MfaProof input, HttpContext ctx, PlatformDb db, UserManager<AppUser> users, SignInManager<AppUser> signIn, MfaService mfa) =>
            {
                await using var tx = await db.Database.BeginTransactionAsync();
                var user = (await users.GetUserAsync(ctx.User))!;
                if (!user.TwoFactorEnabled) return Invalid();
                if (!await Password(user, input.Password, users)) { await db.RecordSecurity(user.Id, SecurityAction.MfaManagementFailed); await tx.CommitAsync(); return Invalid(); }
                if (!await mfa.Verify(user, input.Code, input.Recovery)) { MfaService.Check(await users.AccessFailedAsync(user)); await db.RecordSecurity(user.Id, SecurityAction.MfaManagementFailed); await tx.CommitAsync(); return Invalid(); }
                string[] codes = [];
                if (action == "disable")
                {
                    MfaService.Check(await users.SetTwoFactorEnabledAsync(user, false));
                    MfaService.Check(await users.ResetAuthenticatorKeyAsync(user));
                    await mfa.ClearRecovery(user);
                }
                else codes = await mfa.Codes(user);
                MfaService.Check(await users.ResetAccessFailedCountAsync(user));
                MfaService.Check(await users.UpdateSecurityStampAsync(user));
                await db.RecordSecurity(user.Id, action == "disable" ? SecurityAction.MfaDisabled : SecurityAction.RecoveryCodesReplaced);
                await tx.CommitAsync(); await signIn.RefreshSignInAsync(user);
                return Results.Ok(new { recoveryCodes = codes, enabled = user.TwoFactorEnabled });
            });
        }
    }
    private static async Task<bool> Password(AppUser user, string? password, UserManager<AppUser> users)
    {
        if (await users.IsLockedOutAsync(user)) return false;
        if (password is { Length: > 0 and <= 256 } && await users.CheckPasswordAsync(user, password)) return true;
        MfaService.Check(await users.AccessFailedAsync(user)); return false;
    }
}
public sealed record MfaProof(string? Password, string? Code, bool Recovery = false);
