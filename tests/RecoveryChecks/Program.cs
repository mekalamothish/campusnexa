using System.Buffers.Binary;
using CampusNexa.Api.Platform;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.FileProviders;
using System.Text.Json;
using System.Security.Cryptography;

// Isolated cryptographic checks: ephemeral keys, detached users, no network or database writes.
var services = new ServiceCollection();
services.AddLogging();
services.AddScoped<TenantScope>();
services.AddDbContext<PlatformDb>(o => o.UseNpgsql("Host=unused;Database=unused;Username=unused"));
services.AddIdentityCore<AppUser>().AddEntityFrameworkStores<PlatformDb>();
using var provider = services.BuildServiceProvider();
using var scope = provider.CreateScope();
var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
var protection = new EphemeralDataProtectionProvider();
var tokens = new RecoveryTokenProvider(protection, NullLogger<DataProtectorTokenProvider<AppUser>>.Instance);
var user = new AppUser { Id = Guid.NewGuid(), SecurityStamp = Guid.NewGuid().ToString() };
var code = await tokens.GenerateAsync("ResetPassword", users, user);
var checks = 0;
void Check(bool valid, string label)
{
    if (!valid) throw new Exception("FAIL: " + label);
    checks++; Console.WriteLine("PASS: " + label);
}
Check(await tokens.ValidateAsync("ResetPassword", code, users, user), "valid recovery token");
Check(!await tokens.ValidateAsync("EmailConfirmation", code, users, user), "purpose mismatch rejected");
Check(!await tokens.ValidateAsync("ResetPassword", code, users, new AppUser { Id = Guid.NewGuid(), SecurityStamp = user.SecurityStamp }), "different account rejected");

// Age an ephemeral test token using the .NET 10 provider's serialized UTC-tick prefix.
// This fixture knows only its own throwaway key, never application Data Protection keys.
string Aged(int minutes)
{
    var protector = protection.CreateProtector("CampusNexa.PasswordRecovery.v1");
    var payload = protector.Unprotect(Convert.FromBase64String(code));
    BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(0, sizeof(long)), DateTimeOffset.UtcNow.AddMinutes(-minutes).UtcTicks);
    return Convert.ToBase64String(protector.Protect(payload));
}
Check(await tokens.ValidateAsync("ResetPassword", Aged(29), users, user), "29-minute token accepted");
Check(!await tokens.ValidateAsync("ResetPassword", Aged(31), users, user), "31-minute token expired");
user.SecurityStamp = Guid.NewGuid().ToString();
Check(!await tokens.ValidateAsync("ResetPassword", code, users, user), "security-stamp rotation invalidates token");
Check(!await tokens.ValidateAsync("ResetPassword", "malformed", users, user), "malformed token rejected");
var mfa = new MfaService(users, protection, new TestEnvironment());
var payload = JsonSerializer.Serialize(new { UserId = user.Id.ToString(), Stamp = user.SecurityStamp, Nonce = "test-only" });
var challengeProtector = protection.CreateProtector("CampusNexa.MfaChallenge.v1").ToTimeLimitedDataProtector();
var expired = new DefaultHttpContext();
expired.Request.Headers.Cookie = "CampusNexa.MfaChallenge=" + challengeProtector.Protect(payload, DateTimeOffset.UtcNow.AddMinutes(-1));
Check(await mfa.Resolve(expired) is null, "expired MFA challenge rejected before any database lookup");
var wrongPurpose = new DefaultHttpContext();
wrongPurpose.Request.Headers.Cookie = "CampusNexa.MfaChallenge=" + protection.CreateProtector("OtherPurpose").ToTimeLimitedDataProtector().Protect(payload, TimeSpan.FromMinutes(5));
Check(await mfa.Resolve(wrongPurpose) is null, "wrong-purpose MFA challenge rejected");
Check(await mfa.Resolve(new DefaultHttpContext()) is null, "absent MFA challenge rejected");
var keys = new AuthenticatorKeyProtection(protection);
var plain = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
var ciphertext = keys.Protect(user.Id, plain);
Check(ciphertext.StartsWith(AuthenticatorKeyProtection.Prefix) && !ciphertext.Contains(plain), "authenticator ciphertext excludes plaintext");
Check(keys.Unprotect(user.Id, ciphertext) == plain, "authenticator encryption round trip");
Check(keys.Protect(user.Id, plain) != ciphertext, "authenticator encryption is randomized");
void Reject(Action action, string label)
{
    try { action(); }
    catch (CryptographicException) { Check(true, label); return; }
    Check(false, label);
}
Reject(() => keys.Unprotect(Guid.NewGuid(), ciphertext), "authenticator ciphertext is bound to its account");
Reject(() => keys.Unprotect(user.Id, ciphertext[..^8] + "tampered"), "tampered authenticator ciphertext rejected");
Reject(() => keys.Unprotect(user.Id, plain), "runtime plaintext fallback rejected");
Reject(() => keys.Unprotect(user.Id, ciphertext.Replace("v1:", "v2:")), "unknown authenticator format rejected");
Reject(() => new AuthenticatorKeyProtection(new EphemeralDataProtectionProvider()).Unprotect(user.Id, ciphertext), "missing key ring fails closed");
// Use isolated container temp files, not application keys, to model a process restart.
var keyDirectory = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "campusnexa-checks-" + Guid.NewGuid()));
var firstKeys = new AuthenticatorKeyProtection(DataProtectionProvider.Create(keyDirectory, b => b.SetApplicationName("Checks")));
var persisted = firstKeys.Protect(user.Id, plain);
var restartedKeys = new AuthenticatorKeyProtection(DataProtectionProvider.Create(keyDirectory, b => b.SetApplicationName("Checks")));
Check(restartedKeys.Unprotect(user.Id, persisted) == plain, "authenticator remains readable after provider restart");
// Cursor tests use only throwaway keys; never access the application's key ring.
var cursorScope = new TenantScope { TenantId = Guid.NewGuid(), UserId = Guid.NewGuid(), Role = Roles.OrganizationAdmin };
var paging = new HistoryPaging(protection, cursorScope);
var window = new HistoryWindow(1, DateTimeOffset.UtcNow.AddMinutes(-2), null);
var cursorRows = new List<HistoryAnchor> { new(window.SnapshotAt, window.SnapshotAt.AddSeconds(-1), Guid.NewGuid()), new(window.SnapshotAt, window.SnapshotAt.AddSeconds(-2), Guid.NewGuid()) };
var cursorPage = paging.Finish("audit", window, cursorRows, x => x.BeforeAt!.Value, x => x.BeforeId!.Value);
HttpRequest CursorRequest(string cursor) { var c = new DefaultHttpContext(); c.Request.QueryString = new QueryString("?pageSize=1&cursor=" + Uri.EscapeDataString(cursor)); return c.Request; }
Check(paging.TryRead(CursorRequest(cursorPage.NextCursor!), "audit", out var recovered) && recovered.Anchor!.BeforeId == cursorRows[0].BeforeId, "history cursor round trip");
Check(paging.TryRead(CursorRequest(cursorPage.StartCursor), "audit", out var beginning) && beginning.Anchor!.BeforeId is null && beginning.SnapshotAt == window.SnapshotAt, "start cursor retains browsing cutoff");
Check(!paging.TryRead(CursorRequest(cursorPage.NextCursor!), "invitations", out _), "history resource mismatch rejected");
var originalRole = cursorScope.Role;
var originalUser = cursorScope.UserId; cursorScope.UserId = Guid.NewGuid();
Check(!paging.TryRead(CursorRequest(cursorPage.NextCursor!), "audit", out _), "different history cursor user rejected"); cursorScope.UserId = originalUser;
cursorScope.Role = Roles.BranchAdmin;
Check(!paging.TryRead(CursorRequest(cursorPage.NextCursor!), "audit", out _), "changed cursor role rejected"); cursorScope.Role = originalRole;
cursorScope.BranchId = Guid.NewGuid();
Check(!paging.TryRead(CursorRequest(cursorPage.NextCursor!), "audit", out _), "changed cursor branch rejected"); cursorScope.BranchId = null;
var cursorProtector = protection.CreateProtector("CampusNexa.HistoryCursor.v1", "audit", cursorScope.TenantId.ToString("D"), cursorScope.UserId.ToString("D"), cursorScope.Role, "all", "1").ToTimeLimitedDataProtector();
var expiredCursor = cursorProtector.Protect(JsonSerializer.Serialize(cursorRows[0]), DateTimeOffset.UtcNow.AddMinutes(-1));
Check(!paging.TryRead(CursorRequest(expiredCursor), "audit", out _), "expired history cursor rejected");
Check(!new HistoryPaging(new EphemeralDataProtectionProvider(), cursorScope).TryRead(CursorRequest(cursorPage.NextCursor!), "audit", out _), "history cursor with missing keys fails closed");
Console.WriteLine($"{checks} recovery/MFA/storage/history cryptographic checks passed.");

sealed class TestEnvironment : IWebHostEnvironment
{
    public string EnvironmentName { get; set; } = "Development";
    public string ApplicationName { get; set; } = "Checks";
    public string WebRootPath { get; set; } = "";
    public string ContentRootPath { get; set; } = "";
    public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
    public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
}
