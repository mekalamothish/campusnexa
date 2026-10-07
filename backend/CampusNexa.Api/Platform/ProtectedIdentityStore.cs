using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace CampusNexa.Api.Platform;

public sealed class AuthenticatorKeyProtection(IDataProtectionProvider provider)
{
    public const string Prefix = "cnx-ak:v1:";
    private IDataProtector For(Guid userId) => provider.CreateProtector("CampusNexa.AuthenticatorKey.v1", userId.ToString("D"));
    public static bool IsLegacyKey(string? value) => value is { Length: 32 } && value.All(c => c is >= 'A' and <= 'Z' or >= '2' and <= '7');
    public string Protect(Guid userId, string key)
    {
        if (!IsLegacyKey(key)) throw new CryptographicException("Invalid authenticator key format.");
        return Prefix + For(userId).Protect(key);
    }
    public string Unprotect(Guid userId, string value)
    {
        // Fail closed: plaintext/unknown versions never become a runtime fallback.
        if (!value.StartsWith(Prefix, StringComparison.Ordinal)) throw new CryptographicException("Authenticator storage requires upgrade.");
        var key = For(userId).Unprotect(value[Prefix.Length..]);
        if (!IsLegacyKey(key)) throw new CryptographicException("Invalid authenticator key format.");
        return key;
    }
    public async Task UpgradeAsync(PlatformDb db)
    {
        // Operator-only --migrate path. Stop the old API before running. Row-value comparison
        // also prevents overwriting a key rotated concurrently. No tenant filters are bypassed.
        await using var tx = await db.Database.BeginTransactionAsync();
        var rows = await db.UserTokens.AsNoTracking().Where(t => t.LoginProvider == "[AspNetUserStore]" && t.Name == "AuthenticatorKey").ToListAsync();
        var changed = 0;
        foreach (var row in rows)
        {
            if (row.Value is null) throw new CryptographicException("An authenticator key is missing; upgrade aborted.");
            if (row.Value.StartsWith(Prefix, StringComparison.Ordinal)) { Unprotect(row.UserId, row.Value); continue; }
            var encrypted = Protect(row.UserId, row.Value);
            var count = await db.UserTokens.Where(t => t.UserId == row.UserId && t.LoginProvider == row.LoginProvider && t.Name == row.Name && t.Value == row.Value)
                .ExecuteUpdateAsync(set => set.SetProperty(t => t.Value, encrypted));
            if (count != 1) throw new DbUpdateConcurrencyException("Authenticator changed during upgrade; retry with the API stopped.");
            await db.RecordSecurity(row.UserId, SecurityAction.AuthenticatorKeyProtected);
            changed++;
        }
        await tx.CommitAsync();
        Console.WriteLine($"Authenticator storage validated; {changed} legacy keys protected.");
    }
}

public sealed class ProtectedIdentityStore(PlatformDb db, IdentityErrorDescriber errors, AuthenticatorKeyProtection protection)
    : UserStore<AppUser, IdentityRole<Guid>, PlatformDb, Guid>(db, errors)
{
    public override Task SetAuthenticatorKeyAsync(AppUser user, string key, CancellationToken cancellationToken)
        => base.SetAuthenticatorKeyAsync(user, protection.Protect(user.Id, key), cancellationToken);
    public override async Task<string?> GetAuthenticatorKeyAsync(AppUser user, CancellationToken cancellationToken)
    {
        var value = await base.GetAuthenticatorKeyAsync(user, cancellationToken);
        return value is null ? null : protection.Unprotect(user.Id, value);
    }
}
