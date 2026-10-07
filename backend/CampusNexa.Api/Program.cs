using System.Diagnostics;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Threading.RateLimiting;
using CampusNexa.Api.Platform;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddScoped<TenantScope>();
builder.Services.AddScoped<HistoryPaging>();
builder.Services.AddScoped<InvitationMailer>();
builder.Services.AddSingleton<MailProtection>();
builder.Services.AddScoped<MailDispatcher>();
if (args.Contains("--mail-worker")) builder.Services.AddHostedService<MailWorker>();
builder.Services.AddScoped<MfaService>();
builder.Services.AddSingleton<AuthenticatorKeyProtection>();
var connection = builder.Configuration.GetConnectionString("Database");
if (string.IsNullOrWhiteSpace(connection)) throw new InvalidOperationException("ConnectionStrings__Database is required.");
builder.Services.AddDbContext<PlatformDb>(o => o.UseNpgsql(connection));
builder.Services.AddIdentity<AppUser, IdentityRole<Guid>>(o =>
{
    o.Password.RequiredLength = 12; o.Password.RequireDigit = true; o.Password.RequireNonAlphanumeric = true;
    o.User.RequireUniqueEmail = true; o.SignIn.RequireConfirmedEmail = true;
    o.Lockout.MaxFailedAccessAttempts = 5; o.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(10);
    o.Tokens.PasswordResetTokenProvider = "CampusNexaRecovery";
}).AddEntityFrameworkStores<PlatformDb>().AddDefaultTokenProviders()
    .AddTokenProvider<RecoveryTokenProvider>("CampusNexaRecovery");
builder.Services.AddScoped<IUserStore<AppUser>, ProtectedIdentityStore>();
builder.Services.Configure<SecurityStampValidatorOptions>(o => o.ValidationInterval = TimeSpan.Zero);
builder.Services.ConfigureApplicationCookie(o =>
{
    o.Cookie.Name = "CampusNexa.Session"; o.Cookie.HttpOnly = true; o.Cookie.SameSite = SameSiteMode.Strict;
    o.Cookie.SecurePolicy = builder.Environment.IsDevelopment() ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always;
    o.ExpireTimeSpan = TimeSpan.FromHours(8); o.SlidingExpiration = false;
    o.Events.OnRedirectToLogin = c => { c.Response.StatusCode = 401; return Task.CompletedTask; };
    o.Events.OnRedirectToAccessDenied = c => { c.Response.StatusCode = 403; return Task.CompletedTask; };
});
builder.Services.AddAuthorization();
builder.Services.AddAntiforgery(o => { o.HeaderName = "X-XSRF-TOKEN"; o.Cookie.Name = "CampusNexa.Antiforgery"; o.Cookie.SameSite = SameSiteMode.Strict; o.Cookie.SecurePolicy = builder.Environment.IsDevelopment() ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always; });
builder.Services.AddDataProtection().SetApplicationName("CampusNexa").PersistKeysToFileSystem(new DirectoryInfo(builder.Configuration["DataProtection:Directory"]!));
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = 429;
    o.AddPolicy("mfa", c => RateLimitPartition.GetFixedWindowLimiter(c.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? c.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions { PermitLimit = 30, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    o.AddPolicy("recovery-request", c => RateLimitPartition.GetFixedWindowLimiter(c.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    o.AddPolicy("recovery-reset", c => RateLimitPartition.GetFixedWindowLimiter(c.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions { PermitLimit = 20, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    o.AddPolicy("invitations", c => RateLimitPartition.GetFixedWindowLimiter(c.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? c.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions { PermitLimit = 60, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    o.AddPolicy("login", c => RateLimitPartition.GetFixedWindowLimiter(c.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions { PermitLimit = 20, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});
var app = builder.Build();
if (args.Contains("--mail-status") || args.Contains("--mail-dispatch-once"))
{
    using var scope = app.Services.CreateScope();
    if (!scope.ServiceProvider.GetRequiredService<InvitationMailer>().Available)
        throw new InvalidOperationException("Local mail commands require Development and local mail enabled.");
    var db = scope.ServiceProvider.GetRequiredService<PlatformDb>(); db.MailWorkerAccess = true;
    if (args.Contains("--mail-dispatch-once"))
        await scope.ServiceProvider.GetRequiredService<MailDispatcher>().DispatchOne(CancellationToken.None,
            builder.Configuration["Mail:MessageId"] is string mailId ? Guid.Parse(mailId) : null);
    else
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(await db.MailQueue.AsNoTracking().GroupBy(j => j.Status)
            .Select(g => new { status = g.Key, count = g.Count() }).ToListAsync()));
    return;
}
if (args.Contains("--mail-worker"))
{
    using var scope = app.Services.CreateScope();
    if (!scope.ServiceProvider.GetRequiredService<InvitationMailer>().Available)
        throw new InvalidOperationException("Local mail worker requires Development and local mail enabled.");
    await app.RunAsync(); return;
}
if (args.Contains("--bootstrap-status") || args.Contains("--reissue-bootstrap"))
{
    using var scope = app.Services.CreateScope();
    try { await BootstrapRecovery.RunAsync(scope.ServiceProvider, builder.Configuration, args.Contains("--reissue-bootstrap")); }
    catch (InvalidOperationException e) { Console.Error.WriteLine(e.Message); Environment.ExitCode = 1; }
    catch (Exception e) when (e is DbUpdateException or PostgresException or System.Net.Mail.SmtpException or OperationCanceledException)
    {
        Console.Error.WriteLine("Bootstrap recovery could not commit or deliver. Inspect school status and local services before retrying.");
        Environment.ExitCode = 1;
    }
    return;
}
if (args.Contains("--onboard"))
{
    using var scope = app.Services.CreateScope();
    await Invitations.OnboardAsync(scope.ServiceProvider, builder.Configuration);
    return;
}
if (args.Contains("--migrate"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<PlatformDb>();
    await db.Database.MigrateAsync();
    await scope.ServiceProvider.GetRequiredService<AuthenticatorKeyProtection>().UpgradeAsync(db);
    if (builder.Configuration.GetValue<bool>("Seed:Enabled"))
    {
        if (!app.Environment.IsDevelopment()) throw new InvalidOperationException("Fixture seeding is allowed only in Development.");
        await Seed.RunAsync(scope.ServiceProvider, builder.Configuration["Seed:Password"] ?? "");
    }
    return;
}

app.UseExceptionHandler();
app.Use(async (ctx, next) =>
{
    ctx.Response.Headers.XContentTypeOptions = "nosniff";
    ctx.Response.Headers.CacheControl = "no-store";
    ctx.Response.Headers["X-Request-ID"] = Activity.Current?.TraceId.ToString() ?? ctx.TraceIdentifier;
    try { await next(); }
    catch (BadHttpRequestException e) when (e.StatusCode is >= 400 and < 500)
    { ctx.Response.StatusCode = e.StatusCode; await ctx.Response.WriteAsJsonAsync(new { message = "Invalid request. Check the submitted values." }); }
    catch (CryptographicException)
    { ctx.Response.StatusCode = 503; await ctx.Response.WriteAsJsonAsync(new { message = "Security key storage is unavailable. Contact the local operator; do not reset your authenticator." }); }
    catch (DbUpdateConcurrencyException)
    { ctx.Response.StatusCode = 409; await ctx.Response.WriteAsJsonAsync(new { message = "This record changed. Refresh and try again." }); }
    catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: "23505" })
    { ctx.Response.StatusCode = 409; await ctx.Response.WriteAsJsonAsync(new { message = "A record with that code already exists." }); }
});
app.UseAuthentication();
app.Use(async (ctx, next) =>
{
    if (ctx.User.Identity?.IsAuthenticated == true)
    {
        var users = ctx.RequestServices.GetRequiredService<UserManager<AppUser>>();
        var user = await users.GetUserAsync(ctx.User);
        if (user is null || !user.IsActive)
        {
            await ctx.RequestServices.GetRequiredService<SignInManager<AppUser>>().SignOutAsync();
            ctx.Response.StatusCode = 401; return;
        }
    }
    await next();
});
app.UseAuthorization();
app.UseRateLimiter();
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Path.StartsWithSegments("/api") && !HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method) && !HttpMethods.IsOptions(ctx.Request.Method))
    {
        try { await ctx.RequestServices.GetRequiredService<IAntiforgery>().ValidateRequestAsync(ctx); }
        catch (AntiforgeryValidationException) { ctx.Response.StatusCode = 400; await ctx.Response.WriteAsJsonAsync(new { message = "Your security token expired. Refresh and try again." }); return; }
    }
    await next();
});
app.MapGet("/health/live", () => Results.Ok(new { status = "healthy", service = "CampusNexa API" }));
app.MapGet("/health/ready", async (PlatformDb db) =>
{
    try { return await db.Database.CanConnectAsync() ? Results.Ok(new { status = "ready" }) : Results.StatusCode(503); }
    catch (Exception) { return Results.StatusCode(503); }
});
app.MapPlatform();
app.MapInvitations();
app.MapRecovery();
app.MapMfa();
app.MapSecurityHistory();
app.Run();
