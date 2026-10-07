using Microsoft.AspNetCore.Identity;

namespace CampusNexa.Api.Platform;

public sealed class AppUser : IdentityUser<Guid>
{
    public string DisplayName { get; set; } = "";
    public bool IsActive { get; set; } = true;
}

public sealed class Organization
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string Slug { get; set; } = "";
    public bool IsActive { get; set; } = true;
}

public sealed class Membership
{
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public string Role { get; set; } = Roles.Viewer;
    public Guid? BranchId { get; set; }
    public bool IsActive { get; set; } = true;
}

public interface ITenantEntity { Guid TenantId { get; set; } }

public sealed class Branch : ITenantEntity
{
    public Guid Version { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = "";
    public string Code { get; set; } = "";
    public string? TimeZoneOverride { get; set; }
    public string? LocaleOverride { get; set; }
    public string? CurrencyOverride { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class TenantSettings : ITenantEntity
{
    public Guid Version { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public string DisplayName { get; set; } = "";
    public string TimeZone { get; set; } = "UTC";
    public string Locale { get; set; } = "en-US";
    public string Currency { get; set; } = "USD";
    public string AcademicYearLabel { get; set; } = "Not configured";
}

public sealed class ModuleEntitlement : ITenantEntity
{
    public Guid TenantId { get; set; }
    public string Module { get; set; } = "";
    public bool Enabled { get; set; }
}

public sealed class AuditEvent : ITenantEntity
{
    public Guid TenantId { get; set; }
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid? BranchId { get; set; }
    public Guid ActorId { get; set; }
    public string Action { get; set; } = "";
    public string Subject { get; set; } = "";
    public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow;
}

public static class Roles
{
    public const string OrganizationAdmin = "OrganizationAdmin";
    public const string BranchAdmin = "BranchAdmin";
    public const string Viewer = "Viewer";
}

// Request scoped, deny-by-default. A route parameter alone never establishes a tenant.
public sealed class TenantScope
{
    public Guid TenantId { get; set; }
    public Guid UserId { get; set; }
    public Guid? BranchId { get; set; }
    public string Role { get; set; } = "";
    public bool AllBranches => Role == Roles.OrganizationAdmin;
    public bool CanManageBranches => Role is Roles.OrganizationAdmin or Roles.BranchAdmin;
}
