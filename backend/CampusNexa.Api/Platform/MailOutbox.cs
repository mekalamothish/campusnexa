using System.Net.Mail;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace CampusNexa.Api.Platform;

// Infrastructure queue: denied to ordinary queries; never exposed through tenant APIs.
public sealed class MailOutbox
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid? TenantId { get; set; }
    public Guid? InvitationId { get; set; }
    public Guid? UserId { get; set; }
    public string Kind { get; set; } = "Invitation";
    public string Payload { get; set; } = "";
    public string Status { get; set; } = "Pending";
    public int Attempts { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset AvailableAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public string? LastError { get; set; }
}

public sealed record MailPayload(string Email, string Subject, string Body, string? SecurityStamp = null);

public sealed class MailProtection(IDataProtectionProvider provider)
{
    private IDataProtector For(MailOutbox job) => provider.CreateProtector("CampusNexa.MailOutbox.v1", job.Id.ToString("D"),
        job.Kind, job.TenantId?.ToString("D") ?? "", job.InvitationId?.ToString("D") ?? "", job.UserId?.ToString("D") ?? "");
    public string Protect(MailOutbox job, MailPayload payload) => For(job).Protect(JsonSerializer.Serialize(payload));
    public MailPayload Unprotect(MailOutbox job) => JsonSerializer.Deserialize<MailPayload>(For(job).Unprotect(job.Payload))
        ?? throw new CryptographicException("Invalid queued message.");
}

public sealed class MailDispatcher(PlatformDb db, TenantScope scope, MailProtection protection, InvitationMailer mail)
{
    public async Task<bool> DispatchOne(CancellationToken stop, Guid? messageId = null)
    {
        if (!mail.Available) throw new InvalidOperationException("Local mail delivery is disabled.");
        db.MailWorkerAccess = true;
        await using var tx = await db.Database.BeginTransactionAsync(stop);
        // Reviewed infrastructure-only SQL. Optional operator ID is parameterized; one row lock.
        // SKIP LOCKED lets replicas work independently. A crash releases the DB lock.
        var query = messageId is Guid id ? db.MailQueue.FromSqlInterpolated($"""
            SELECT * FROM "MailQueue" WHERE "Id" = {id} AND "Status" = 'Pending' AND "AvailableAt" <= now()
            FOR UPDATE SKIP LOCKED
            """) : db.MailQueue.FromSqlRaw("""
            SELECT * FROM "MailQueue" WHERE "Status" = 'Pending' AND "AvailableAt" <= now()
            ORDER BY "AvailableAt", "Id" LIMIT 1 FOR UPDATE SKIP LOCKED
            """);
        var job = await query.SingleOrDefaultAsync(stop);
        if (job is null) return false;
        void Finish(string status, string? error = null)
        {
            job.Status = status; job.CompletedAt = DateTimeOffset.UtcNow; job.Payload = ""; job.LastError = error;
        }
        if (job.ExpiresAt <= DateTimeOffset.UtcNow) Finish("Expired");
        else
        {
            try
            {
                var payload = protection.Unprotect(job);
                bool eligible;
                if (job.Kind == "Invitation")
                {
                    scope.TenantId = job.TenantId!.Value; scope.Role = Roles.OrganizationAdmin;
                    eligible = await db.Invitations.AnyAsync(i => i.Id == job.InvitationId && i.AcceptedAt == null && i.RevokedAt == null && i.ExpiresAt > DateTimeOffset.UtcNow && i.Email == payload.Email, stop)
                        && await db.Organizations.AnyAsync(o => o.Id == job.TenantId && o.IsActive, stop)
                        && await db.Entitlements.AnyAsync(e => e.Module == "platform" && e.Enabled, stop);
                }
                else
                    eligible = await db.Users.AnyAsync(u => u.Id == job.UserId && u.IsActive && u.EmailConfirmed && u.Email == payload.Email && u.SecurityStamp == payload.SecurityStamp, stop);
                if (!eligible) Finish("Cancelled");
                else
                {
                    job.Attempts++;
                    await mail.DeliverAsync(job.Id, payload, stop);
                    Finish("Sent");
                }
            }
            catch (Exception e) when (e is CryptographicException or JsonException)
            { Finish("Dead", "PayloadUnavailable"); }
            catch (Exception e) when (e is SmtpException || e is OperationCanceledException && !stop.IsCancellationRequested)
            {
                job.LastError = "DeliveryFailed";
                if (job.Attempts >= 5)
                {
                    Finish("Dead", "DeliveryFailed");
                    if (job.UserId is Guid userId) await db.RecordSecurity(userId, SecurityAction.RecoveryDeliveryFailed);
                }
                else job.AvailableAt = DateTimeOffset.UtcNow.AddSeconds(30 * Math.Pow(2, job.Attempts - 1));
            }
        }
        await db.SaveChangesAsync(stop);
        await tx.CommitAsync(stop);
        return true;
    }
}

public sealed class MailWorker(IServiceScopeFactory scopes, ILogger<MailWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                if (await scope.ServiceProvider.GetRequiredService<MailDispatcher>().DispatchOne(stoppingToken)) continue;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception) { log.LogWarning("Mail worker could not process a job; retrying. Check database and key storage."); }
            try { await Task.Delay(500, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
    }
}
