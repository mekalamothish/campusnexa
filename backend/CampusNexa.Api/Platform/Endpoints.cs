using System.Globalization;
using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace CampusNexa.Api.Platform;

public static partial class Endpoints
{
    public static void MapPlatform(this WebApplication app)
    {
        app.MapGet("/api/auth/csrf", (HttpContext ctx, IAntiforgery anti, IWebHostEnvironment env) =>
        {
            var tokens = anti.GetAndStoreTokens(ctx);
            ctx.Response.Cookies.Append("XSRF-TOKEN", tokens.RequestToken!, new CookieOptions { HttpOnly = false, Secure = !env.IsDevelopment(), SameSite = SameSiteMode.Strict, Path = "/" });
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.NoContent();
        });
        app.MapPost("/api/auth/login", async (LoginRequest input, SignInManager<AppUser> signIn, UserManager<AppUser> users, HttpContext ctx, MfaService mfa, PlatformDb db) =>
        {
            await signIn.SignOutAsync(); mfa.Clear(ctx);
            if (string.IsNullOrWhiteSpace(input.Email) || input.Email.Length > 254 || string.IsNullOrEmpty(input.Password) || input.Password.Length > 256) return Results.BadRequest(new { message = "Enter a valid email and password." });
            await using var tx = await db.Database.BeginTransactionAsync();
            var user = await users.FindByEmailAsync(input.Email.Trim());
            if (user is null) return Results.Json(new { message = "Unable to sign in with those details." }, statusCode: 401);
            if (!user.IsActive) { await db.RecordSecurity(user.Id, SecurityAction.SignInFailed); await tx.CommitAsync(); return Results.Json(new { message = "Unable to sign in with those details." }, statusCode: 401); }
            var result = await signIn.CheckPasswordSignInAsync(user, input.Password, true);
            if (!result.Succeeded) { await db.RecordSecurity(user.Id, SecurityAction.SignInFailed); await tx.CommitAsync(); return Results.Json(new { message = "Unable to sign in with those details." }, statusCode: 401); }
            if (user.TwoFactorEnabled)
            {
                await mfa.Issue(user, ctx);
                await db.RecordSecurity(user.Id, SecurityAction.MfaChallengeStarted); await tx.CommitAsync();
                return Results.Ok(new { requiresMfa = true });
            }
            await db.RecordSecurity(user.Id, SecurityAction.PasswordSignIn); await tx.CommitAsync();
            await signIn.SignInAsync(user, false);
            return Results.NoContent();
        }).RequireRateLimiting("login");
        app.MapPost("/api/auth/logout", async (HttpContext ctx, UserManager<AppUser> users, PlatformDb db, SignInManager<AppUser> signIn) => { var user = (await users.GetUserAsync(ctx.User))!; await db.RecordSecurity(user.Id, SecurityAction.SignedOut); await signIn.SignOutAsync(); return Results.NoContent(); }).RequireAuthorization();
        app.MapPost("/api/auth/revoke-sessions", async (ClaimsPrincipal principal, UserManager<AppUser> users, SignInManager<AppUser> signIn, PlatformDb db) =>
        {
            await using var tx = await db.Database.BeginTransactionAsync();
            var user = await users.GetUserAsync(principal);
            if (user is null) return Results.Unauthorized();
            MfaService.Check(await users.UpdateSecurityStampAsync(user));
            await db.RecordSecurity(user.Id, SecurityAction.SessionsRevoked); await tx.CommitAsync();
            await signIn.SignOutAsync();
            return Results.NoContent();
        }).RequireAuthorization();
        app.MapGet("/api/auth/me", async (ClaimsPrincipal principal, UserManager<AppUser> users, PlatformDb db) =>
        {
            var user = await users.GetUserAsync(principal);
            if (user is null) return Results.Unauthorized();
            var memberships = await (from m in db.Memberships.AsNoTracking()
                                     join o in db.Organizations on m.TenantId equals o.Id
                                     where m.UserId == user.Id && m.IsActive && o.IsActive
                                     select new { tenantId = o.Id, name = o.Name, role = m.Role, branchId = m.BranchId }).ToListAsync();
            return Results.Ok(new { user.Id, user.Email, user.DisplayName, memberships });
        }).RequireAuthorization();

        var group = app.MapGroup("/api/tenants/{tenantId:guid}").RequireAuthorization().AddEndpointFilter<TenantAccess>();
        group.MapGet("/overview", async (PlatformDb db, TenantScope scope) => Results.Ok(new
        {
            branches = await db.Branches.CountAsync(),
            members = scope.AllBranches ? await db.Memberships.CountAsync(x => x.TenantId == scope.TenantId && x.IsActive) : await db.Memberships.CountAsync(x => x.TenantId == scope.TenantId && x.BranchId == scope.BranchId && x.IsActive),
            enabledModules = await db.Entitlements.CountAsync(x => x.Enabled),
            recentActivity = await db.AuditEvents.AsNoTracking().OrderByDescending(x => x.OccurredAt).Take(6).Select(x => new { x.Id, x.Action, x.Subject, x.OccurredAt }).ToListAsync()
        }));
        group.MapGet("/branches", async (PlatformDb db) => Results.Ok(await db.Branches.AsNoTracking().OrderBy(x => x.CreatedAt).Take(200).ToListAsync()));
        group.MapGet("/branches/{branchId:guid}", async (Guid branchId, PlatformDb db) =>
        {
            var branch = await db.Branches.AsNoTracking().SingleOrDefaultAsync(x => x.Id == branchId);
            return branch is null ? Results.NotFound() : Results.Ok(branch);
        });
        group.MapPost("/branches", async (BranchRequest input, PlatformDb db, TenantScope scope) =>
        {
            if (!scope.AllBranches) return Results.Forbid();
            if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Trim().Length > 120 || string.IsNullOrWhiteSpace(input.Code) || !CodePattern().IsMatch(input.Code.Trim()))
                return Results.BadRequest(new { message = "Branch name must be 1–120 characters and code 2–12 letters, numbers or hyphens." });
            var code = input.Code.Trim().ToUpperInvariant();
            if (await db.Branches.AnyAsync(x => x.Code == code)) return Results.Conflict(new { message = "This branch code is already in use." });
            var branch = new Branch { TenantId = scope.TenantId, Name = input.Name.Trim(), Code = code };
            db.Branches.Add(branch); db.Audit("branch.created", branch.Name, branch.Id);
            await db.SaveChangesAsync();
            return Results.Created($"/api/tenants/{scope.TenantId}/branches/{branch.Id}", branch);
        });
        group.MapGet("/settings", async (PlatformDb db) => Results.Ok(await db.Settings.AsNoTracking().SingleAsync()));
        group.MapPut("/settings", async (SettingsRequest input, PlatformDb db, TenantScope scope) =>
        {
            if (!scope.AllBranches) return Results.Forbid();
            if (input.Version is null || input.Version == Guid.Empty) return VersionRequired();
            if (!ValidSettings(input.DisplayName, input.TimeZone, input.Locale, input.Currency) || string.IsNullOrWhiteSpace(input.AcademicYearLabel) || input.AcademicYearLabel.Length > 40)
                return Results.BadRequest(new { message = "Check the display name, timezone, locale, currency and academic year label." });
            var settings = await db.Settings.SingleAsync();
            if (settings.Version != input.Version) return SettingsConflict();
            settings.DisplayName = input.DisplayName.Trim(); settings.TimeZone = input.TimeZone; settings.Locale = input.Locale;
            settings.Currency = input.Currency; settings.AcademicYearLabel = input.AcademicYearLabel.Trim();
            // An unchanged save also consumes the version; duplicate submissions cannot
            // create two successful audit events.
            settings.Version = Guid.NewGuid();
            db.Audit("settings.updated", "Organization preferences"); await db.SaveChangesAsync();
            return Results.Ok(settings);
        });
        group.MapGet("/branches/{branchId:guid}/settings", async (Guid branchId, PlatformDb db) =>
        {
            var branch = await db.Branches.AsNoTracking().SingleOrDefaultAsync(x => x.Id == branchId);
            if (branch is null) return Results.NotFound();
            var settings = await db.Settings.AsNoTracking().SingleAsync();
            return Results.Ok(new { branch.Id, branch.Version, defaultsVersion = settings.Version, timeZone = branch.TimeZoneOverride ?? settings.TimeZone, locale = branch.LocaleOverride ?? settings.Locale, currency = branch.CurrencyOverride ?? settings.Currency, settings.AcademicYearLabel, branch.TimeZoneOverride, branch.LocaleOverride, branch.CurrencyOverride });
        });
        group.MapPut("/branches/{branchId:guid}/settings", async (Guid branchId, BranchSettingsRequest input, PlatformDb db, TenantScope scope) =>
        {
            if (!scope.CanManageBranches) return Results.Forbid();
            var branch = await db.Branches.SingleOrDefaultAsync(x => x.Id == branchId);
            if (branch is null) return Results.NotFound();
            if (input.Version is null || input.Version == Guid.Empty) return VersionRequired();
            if (branch.Version != input.Version) return SettingsConflict();
            if (!ValidSettings("Branch", input.TimeZone ?? "UTC", input.Locale ?? "en-US", input.Currency ?? "USD"))
                return Results.BadRequest(new { message = "Invalid branch settings." });
            branch.TimeZoneOverride = input.TimeZone; branch.LocaleOverride = input.Locale; branch.CurrencyOverride = input.Currency;
            branch.Version = Guid.NewGuid();
            db.Audit("branch.settings.updated", branch.Name, branch.Id); await db.SaveChangesAsync();
            return Results.Ok(branch);
        });
        group.MapGet("/modules", async (PlatformDb db) => Results.Ok(await db.Entitlements.AsNoTracking().OrderBy(x => x.Module).Select(x => new { x.Module, x.Enabled }).ToListAsync()));
        group.MapGet("/members", async (PlatformDb db, TenantScope scope) =>
        {
            if (!scope.CanManageBranches) return Results.Forbid();
            return Results.Ok(await (from m in db.Memberships.AsNoTracking()
                                     join u in db.Users on m.UserId equals u.Id
                                     where m.TenantId == scope.TenantId && (scope.AllBranches || m.BranchId == scope.BranchId)
                                     select new { u.Id, u.DisplayName, u.Email, m.Role, m.BranchId, isActive = m.IsActive && u.IsActive }).Take(200).ToListAsync());
        });
        group.MapGet("/audit", async (HttpRequest request, PlatformDb db, HistoryPaging paging) =>
        {
            if (!paging.TryRead(request, "audit", out var page)) return HistoryPaging.Invalid();
            var query = db.AuditEvents.AsNoTracking().Where(a => a.OccurredAt <= page.SnapshotAt);
            if (page.Anchor is { BeforeAt: { } beforeAt, BeforeId: { } beforeId }) query = query.Where(a => EF.Functions.LessThan(
                ValueTuple.Create(a.OccurredAt, a.Id), ValueTuple.Create(beforeAt, beforeId)));
            var rows = await query.OrderByDescending(a => a.OccurredAt).ThenByDescending(a => a.Id).Take(page.PageSize + 1)
                .Select(a => new { a.Id, a.ActorId, a.BranchId, a.Action, a.Subject, a.OccurredAt }).ToListAsync();
            return Results.Ok(paging.Finish("audit", page, rows, a => a.OccurredAt, a => a.Id));
        });
        // Entitlement guard demonstrated without pretending the academic module is implemented.
        group.MapGet("/academics", async (PlatformDb db) => await db.Entitlements.AnyAsync(x => x.Module == "academics" && x.Enabled)
            ? Results.Json(new { message = "Academic module implementation is scheduled for Phase 3." }, statusCode: 501) : Results.Forbid());
    }

    private static IResult VersionRequired() => Results.Json(new { code = "settings_version_required", message = "Reload settings before saving. A current version is required." }, statusCode: 428);
    private static IResult SettingsConflict() => Results.Conflict(new { code = "settings_conflict", message = "These settings changed since you opened them. Your edits have not been saved. Reload the saved values and review your changes." });

    private static bool ValidSettings(string name, string timezone, string locale, string currency)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Trim().Length > 120 || string.IsNullOrWhiteSpace(timezone) || timezone.Length > 80 || string.IsNullOrWhiteSpace(locale) || locale.Length > 35 || string.IsNullOrWhiteSpace(currency) || !CurrencyPattern().IsMatch(currency)) return false;
        try { _ = TimeZoneInfo.FindSystemTimeZoneById(timezone); _ = CultureInfo.GetCultureInfo(locale); return true; }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException or CultureNotFoundException) { return false; }
    }
    [GeneratedRegex("^[A-Za-z0-9-]{2,12}$")] private static partial Regex CodePattern();
    [GeneratedRegex("^[A-Z]{3}$")] private static partial Regex CurrencyPattern();
}

public sealed record LoginRequest(string Email, string Password);
public sealed record BranchRequest(string Name, string Code);
public sealed record SettingsRequest(string DisplayName, string TimeZone, string Locale, string Currency, string AcademicYearLabel, Guid? Version = null);
public sealed record BranchSettingsRequest(string? TimeZone, string? Locale, string? Currency, Guid? Version = null);
