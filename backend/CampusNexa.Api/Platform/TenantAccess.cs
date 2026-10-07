using System.Security.Claims;
using Microsoft.EntityFrameworkCore;

namespace CampusNexa.Api.Platform;

public sealed class TenantAccess(PlatformDb db, TenantScope scope) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext c, EndpointFilterDelegate next)
    {
        if (!Guid.TryParse(c.HttpContext.User.FindFirstValue(ClaimTypes.NameIdentifier), out var userId)
            || !Guid.TryParse(c.HttpContext.Request.RouteValues["tenantId"]?.ToString(), out var tenantId))
            return Results.NotFound();
        var membership = await db.Memberships.AsNoTracking().SingleOrDefaultAsync(x => x.TenantId == tenantId && x.UserId == userId && x.IsActive);
        if (membership is null || !await db.Organizations.AnyAsync(x => x.Id == tenantId && x.IsActive)) return Results.NotFound();
        scope.TenantId = tenantId;
        scope.UserId = userId;
        scope.Role = membership.Role;
        scope.BranchId = membership.BranchId;
        if (!await db.Entitlements.AnyAsync(x => x.Module == "platform" && x.Enabled)) return Results.Forbid();
        return await next(c);
    }
}
