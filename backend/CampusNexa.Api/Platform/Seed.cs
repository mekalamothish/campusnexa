using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace CampusNexa.Api.Platform;

public static class Seed
{
    public static async Task RunAsync(IServiceProvider services, string password)
    {
        if (password.Length < 16) throw new InvalidOperationException("Seed password must contain at least 16 characters.");
        var db = services.GetRequiredService<PlatformDb>();
        var users = services.GetRequiredService<UserManager<AppUser>>();
        var scope = services.GetRequiredService<TenantScope>();
        var alpha = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var beta = Guid.Parse("22222222-2222-2222-2222-222222222222");
        foreach (var item in new[] { (alpha, "Greenfield Education", "greenfield", "admin@campusnexa.test"), (beta, "Lakeside Learning", "lakeside", "other@campusnexa.test") })
        {
            scope.TenantId = item.Item1; scope.Role = Roles.OrganizationAdmin;
            if (await db.Organizations.AnyAsync(x => x.Id == item.Item1)) continue;
            await using var tx = await db.Database.BeginTransactionAsync();
            var user = new AppUser { Id = Guid.NewGuid(), UserName = item.Item4, Email = item.Item4, EmailConfirmed = true, DisplayName = "Organization administrator" };
            var result = await users.CreateAsync(user, password);
            if (!result.Succeeded) throw new InvalidOperationException("Seed account creation failed: " + string.Join(", ", result.Errors.Select(x => x.Code)));
            var main = new Branch { TenantId = item.Item1, Name = "Main Campus", Code = "MAIN" };
            db.Organizations.Add(new Organization { Id = item.Item1, Name = item.Item2, Slug = item.Item3 });
            db.Branches.AddRange(main, new Branch { TenantId = item.Item1, Name = "North Campus", Code = "NORTH" });
            db.Settings.Add(new TenantSettings { TenantId = item.Item1, DisplayName = item.Item2 });
            db.Memberships.Add(new Membership { TenantId = item.Item1, UserId = user.Id, Role = Roles.OrganizationAdmin });
            foreach (var module in new[] { "platform", "academics", "finance", "communication", "campus", "reports" })
                db.Entitlements.Add(new ModuleEntitlement { TenantId = item.Item1, Module = module, Enabled = module == "platform" });
            scope.UserId = user.Id;
            db.Audit("organization.seeded", item.Item2);
            await db.SaveChangesAsync();
            if (item.Item1 == alpha)
            {
                foreach (var role in new[] { ("branch@campusnexa.test", Roles.BranchAdmin), ("viewer@campusnexa.test", Roles.Viewer) })
                {
                    var branchUser = new AppUser { Id = Guid.NewGuid(), UserName = role.Item1, Email = role.Item1, EmailConfirmed = true, DisplayName = role.Item2 == Roles.Viewer ? "Campus viewer" : "Campus administrator" };
                    var created = await users.CreateAsync(branchUser, password);
                    if (!created.Succeeded) throw new InvalidOperationException("Seed branch account creation failed.");
                    db.Memberships.Add(new Membership { TenantId = alpha, UserId = branchUser.Id, Role = role.Item2, BranchId = main.Id });
                }
                await db.SaveChangesAsync();
            }
            await tx.CommitAsync();
        }
    }
}
