using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace CampusNexa.Api.Platform;

public sealed class PlatformDb(DbContextOptions<PlatformDb> options, TenantScope scope)
    : IdentityDbContext<AppUser, IdentityRole<Guid>, Guid>(options)
{
    public DbSet<Organization> Organizations => Set<Organization>();
    public DbSet<Membership> Memberships => Set<Membership>();
    public DbSet<Branch> Branches => Set<Branch>();
    public DbSet<TenantSettings> Settings => Set<TenantSettings>();
    public DbSet<ModuleEntitlement> Entitlements => Set<ModuleEntitlement>();
    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();
    public DbSet<Invitation> Invitations => Set<Invitation>();
    public DbSet<SecurityEvent> SecurityEvents => Set<SecurityEvent>();
    public DbSet<MailOutbox> MailQueue => Set<MailOutbox>();
    public bool MailWorkerAccess { get; set; }
    public bool InvitationDeliveryReadAccess { get; set; } // Explicit opt-in, still constrained by validated tenant/admin scope.
    public Guid SecurityReaderId { get; set; } // Deny-by-default account-global history filter.

    protected override void OnModelCreating(ModelBuilder b)
    {
        base.OnModelCreating(b);
        b.Entity<MailOutbox>().ToTable("MailQueue", t =>
        {
            t.HasCheckConstraint("CK_Mail_Scope", "(\"Kind\" = 'Invitation' AND \"TenantId\" IS NOT NULL AND \"InvitationId\" IS NOT NULL AND \"UserId\" IS NULL) OR (\"Kind\" = 'Recovery' AND \"TenantId\" IS NULL AND \"InvitationId\" IS NULL AND \"UserId\" IS NOT NULL)");
            t.HasCheckConstraint("CK_Mail_Status", "\"Status\" IN ('Pending','Sent','Dead','Expired','Cancelled') AND \"Attempts\" BETWEEN 0 AND 5");
        });
        b.Entity<MailOutbox>().HasKey(x => x.Id);
        b.Entity<MailOutbox>().HasQueryFilter(x => MailWorkerAccess ||
            (InvitationDeliveryReadAccess && scope.AllBranches && scope.TenantId != Guid.Empty &&
             x.Kind == "Invitation" && x.TenantId == scope.TenantId));
        b.Entity<MailOutbox>().HasOne<Invitation>().WithMany().HasForeignKey(x => new { x.TenantId, x.InvitationId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<MailOutbox>().HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<MailOutbox>().HasIndex(x => new { x.TenantId, x.InvitationId }).IsUnique();
        b.Entity<MailOutbox>().HasIndex(x => new { x.AvailableAt, x.Id }).HasFilter("\"Status\" = 'Pending'");
        b.Entity<MailOutbox>().Property(x => x.Kind).HasMaxLength(20);
        b.Entity<MailOutbox>().Property(x => x.Status).HasMaxLength(20);
        b.Entity<MailOutbox>().Property(x => x.LastError).HasMaxLength(40);
        b.Entity<SecurityEvent>().HasKey(x => x.Id);
        b.Entity<SecurityEvent>().HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<SecurityEvent>().Property(x => x.Action).HasConversion<string>().HasMaxLength(80);
        b.Entity<SecurityEvent>().HasIndex(x => new { x.UserId, x.OccurredAt, x.Id });
        b.Entity<SecurityEvent>().HasQueryFilter(x => x.UserId == SecurityReaderId);
        b.Entity<SecurityEvent>().ToTable(t => t.HasCheckConstraint("CK_SecurityEvent_Action", "\"Action\" IN (" + string.Join(",", Enum.GetNames<SecurityAction>().Select(n => "'" + n + "'")) + ")"));
        b.Entity<Invitation>().HasKey(x => new { x.TenantId, x.Id });
        b.Entity<Invitation>().HasOne<Organization>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<Invitation>().HasOne<Branch>().WithMany().HasForeignKey(x => new { x.TenantId, x.BranchId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<Invitation>().Property(x => x.Email).HasMaxLength(254);
        b.Entity<Invitation>().Property(x => x.NormalizedEmail).HasMaxLength(254);
        b.Entity<Invitation>().Property(x => x.TokenHash).HasMaxLength(64);
        b.Entity<Invitation>().HasIndex(x => x.TokenHash).IsUnique();
        b.Entity<Invitation>().HasIndex(x => new { x.TenantId, x.CreatedAt, x.Id });
        b.Entity<Invitation>().HasIndex(x => new { x.TenantId, x.NormalizedEmail }).IsUnique().HasFilter("\"AcceptedAt\" IS NULL AND \"RevokedAt\" IS NULL");
        b.Entity<Invitation>().Property(x => x.AcceptedAt).IsConcurrencyToken();
        b.Entity<Invitation>().Property(x => x.RevokedAt).IsConcurrencyToken();
        b.Entity<Invitation>().HasQueryFilter(x => x.TenantId == scope.TenantId && scope.AllBranches);
        b.Entity<Invitation>().ToTable(t => t.HasCheckConstraint("CK_Invitation_Role", "\"Role\" IN ('OrganizationAdmin', 'BranchAdmin', 'Viewer') AND ((\"Role\" = 'OrganizationAdmin' AND \"BranchId\" IS NULL) OR (\"Role\" <> 'OrganizationAdmin' AND \"BranchId\" IS NOT NULL))"));
        b.Entity<Organization>().HasIndex(x => x.Slug).IsUnique();
        b.Entity<Organization>().Property(x => x.Name).HasMaxLength(120);
        b.Entity<Organization>().Property(x => x.Slug).HasMaxLength(80);
        b.Entity<Membership>().HasKey(x => new { x.TenantId, x.UserId });
        b.Entity<Membership>().HasOne<Organization>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<Membership>().HasOne<AppUser>().WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<Membership>().HasOne<Branch>().WithMany().HasForeignKey(x => new { x.TenantId, x.BranchId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<Membership>().ToTable(t => t.HasCheckConstraint("CK_Membership_Role", "\"Role\" IN ('OrganizationAdmin', 'BranchAdmin', 'Viewer') AND ((\"Role\" = 'OrganizationAdmin' AND \"BranchId\" IS NULL) OR (\"Role\" <> 'OrganizationAdmin' AND \"BranchId\" IS NOT NULL))"));
        b.Entity<Branch>().HasKey(x => new { x.TenantId, x.Id });
        b.Entity<Branch>().HasOne<Organization>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<Branch>().HasIndex(x => new { x.TenantId, x.Code }).IsUnique();
        b.Entity<Branch>().Property(x => x.Name).HasMaxLength(120);
        b.Entity<Branch>().Property(x => x.Code).HasMaxLength(12);
        b.Entity<Branch>().Property(x => x.Version).IsConcurrencyToken().HasDefaultValueSql("gen_random_uuid()");
        b.Entity<Branch>().HasQueryFilter(x => x.TenantId == scope.TenantId && (scope.AllBranches || x.Id == scope.BranchId));
        b.Entity<TenantSettings>().HasKey(x => x.TenantId);
        b.Entity<TenantSettings>().Property(x => x.Version).IsConcurrencyToken().HasDefaultValueSql("gen_random_uuid()");
        b.Entity<TenantSettings>().HasOne<Organization>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<TenantSettings>().HasQueryFilter(x => x.TenantId == scope.TenantId);
        b.Entity<ModuleEntitlement>().HasKey(x => new { x.TenantId, x.Module });
        b.Entity<ModuleEntitlement>().HasOne<Organization>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<ModuleEntitlement>().HasQueryFilter(x => x.TenantId == scope.TenantId);
        b.Entity<AuditEvent>().HasKey(x => new { x.TenantId, x.Id });
        b.Entity<AuditEvent>().HasIndex(x => new { x.TenantId, x.OccurredAt });
        b.Entity<AuditEvent>().HasIndex(x => new { x.TenantId, x.OccurredAt, x.Id });
        b.Entity<AuditEvent>().HasIndex(x => new { x.TenantId, x.BranchId, x.OccurredAt, x.Id });
        b.Entity<AuditEvent>().HasOne<Organization>().WithMany().HasForeignKey(x => x.TenantId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<AuditEvent>().HasOne<Branch>().WithMany().HasForeignKey(x => new { x.TenantId, x.BranchId }).OnDelete(DeleteBehavior.Restrict);
        b.Entity<AuditEvent>().HasQueryFilter(x => x.TenantId == scope.TenantId && (scope.AllBranches || x.BranchId == scope.BranchId));
    }

    private void ValidateWrites()
    {
        foreach (var entry in ChangeTracker.Entries<MailOutbox>())
        {
            if (entry.State == EntityState.Deleted || entry.State == EntityState.Modified && !MailWorkerAccess)
                throw new InvalidOperationException("Only the mail worker can change delivery state.");
            if (entry.State == EntityState.Added && entry.Entity.Kind == "Invitation" && (scope.TenantId != entry.Entity.TenantId || !scope.AllBranches))
                throw new InvalidOperationException("A validated tenant is required to queue invitations.");
        }
        foreach (var entry in ChangeTracker.Entries<SecurityEvent>())
        {
            if (entry.State is EntityState.Modified or EntityState.Deleted) throw new InvalidOperationException("Security events are append-only.");
            if (entry.State == EntityState.Added && (entry.Entity.UserId == Guid.Empty || !Enum.IsDefined(entry.Entity.Action)))
                throw new InvalidOperationException("A known account and action are required for security events.");
        }
        foreach (var entry in ChangeTracker.Entries<ITenantEntity>().Where(x => x.State is EntityState.Added or EntityState.Modified or EntityState.Deleted))
        {
            if (scope.TenantId == Guid.Empty || entry.Entity.TenantId != scope.TenantId)
                throw new InvalidOperationException("A validated tenant scope is required for writes.");
            if (entry.State != EntityState.Added && entry.OriginalValues.GetValue<Guid>("TenantId") != scope.TenantId)
                throw new InvalidOperationException("Moving records between tenants is forbidden.");
            if (entry.Entity is Branch branch && !scope.AllBranches && branch.Id != scope.BranchId)
                throw new InvalidOperationException("Branch scope violation.");
            if (entry.Entity is Invitation && !scope.AllBranches)
                throw new InvalidOperationException("Organization administrator scope is required for invitations.");
            if (entry.Entity is AuditEvent && entry.State != EntityState.Added)
                throw new InvalidOperationException("Audit records are append-only.");
            // Keep original versions in the UPDATE predicate; all tracked writes rotate them.
            if (entry.State == EntityState.Modified && entry.Entity is TenantSettings settings)
                settings.Version = Guid.NewGuid();
            if (entry.State == EntityState.Modified && entry.Entity is Branch changedBranch)
                changedBranch.Version = Guid.NewGuid();
        }
    }

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        ValidateWrites();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken token = default)
    {
        ValidateWrites();
        return base.SaveChangesAsync(acceptAllChangesOnSuccess, token);
    }

    public void Audit(string action, string subject, Guid? branchId = null) => AuditEvents.Add(new AuditEvent
    {
        TenantId = scope.TenantId,
        ActorId = scope.UserId,
        BranchId = branchId,
        Action = action,
        Subject = subject
    });

    public async Task RecordSecurity(Guid userId, SecurityAction action)
    {
        SecurityEvents.Add(new SecurityEvent { UserId = userId, Action = action });
        await SaveChangesAsync();
    }
}

public sealed class DesignTimeDb : IDesignTimeDbContextFactory<PlatformDb>
{
    public PlatformDb CreateDbContext(string[] args) => new(new DbContextOptionsBuilder<PlatformDb>()
        .UseNpgsql("Host=localhost;Database=campusnexa;Username=campusnexa").Options, new TenantScope());
}
