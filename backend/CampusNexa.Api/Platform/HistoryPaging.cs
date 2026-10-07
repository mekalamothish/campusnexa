using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace CampusNexa.Api.Platform;

public sealed record HistoryAnchor(DateTimeOffset SnapshotAt, DateTimeOffset? BeforeAt, Guid? BeforeId);
public sealed record HistoryWindow(int PageSize, DateTimeOffset SnapshotAt, HistoryAnchor? Anchor);
public sealed record HistoryPage<T>(IReadOnlyList<T> Items, string? NextCursor, string StartCursor, int PageSize, DateTimeOffset SnapshotAt);

// A cursor is a protected seek position, never authorization. TenantAccess and EF
// filters must run on every page, including after membership/role changes.
public sealed class HistoryPaging(IDataProtectionProvider protection, TenantScope scope)
{
    private ITimeLimitedDataProtector Protector(string resource, int size) => protection.CreateProtector(
        "CampusNexa.HistoryCursor.v1", resource, scope.TenantId.ToString("D"), scope.UserId.ToString("D"),
        scope.Role, scope.BranchId?.ToString("D") ?? "all", size.ToString(CultureInfo.InvariantCulture)).ToTimeLimitedDataProtector();

    public static IResult Invalid() => Results.BadRequest(new { message = "Invalid or expired history cursor/page size. Refresh to start from the latest records." });

    public bool TryRead(HttpRequest request, string resource, out HistoryWindow window)
    {
        window = new(25, DateTimeOffset.UtcNow, null);
        if (request.Query.TryGetValue("pageSize", out var size))
        {
            if (size.Count != 1 || !int.TryParse(size[0], NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed is < 1 or > 100) return false;
            window = window with { PageSize = parsed };
        }
        if (!request.Query.TryGetValue("cursor", out var cursor)) return true;
        if (cursor.Count != 1 || string.IsNullOrEmpty(cursor[0]) || cursor[0]!.Length > 2048) return false;
        try
        {
            var anchor = JsonSerializer.Deserialize<HistoryAnchor>(Protector(resource, window.PageSize).Unprotect(cursor[0]!));
            if (anchor is null || anchor.BeforeId == Guid.Empty || (anchor.BeforeAt is null) != (anchor.BeforeId is null) || anchor.BeforeAt > anchor.SnapshotAt ||
                anchor.SnapshotAt > DateTimeOffset.UtcNow || (anchor.BeforeAt is { } before && before.Offset != TimeSpan.Zero) || anchor.SnapshotAt.Offset != TimeSpan.Zero) return false;
            window = window with { SnapshotAt = anchor.SnapshotAt, Anchor = anchor };
            return true;
        }
        catch (Exception e) when (e is CryptographicException or JsonException or FormatException) { return false; }
    }

    public HistoryPage<T> Finish<T>(string resource, HistoryWindow window, List<T> rows, Func<T, DateTimeOffset> timestamp, Func<T, Guid> id)
    {
        var more = rows.Count > window.PageSize;
        if (more) rows.RemoveAt(rows.Count - 1);
        var cursor = more ? Protector(resource, window.PageSize).Protect(JsonSerializer.Serialize(
            new HistoryAnchor(window.SnapshotAt, timestamp(rows[^1]), id(rows[^1]))), window.SnapshotAt.AddHours(1)) : null;
        var start = Protector(resource, window.PageSize).Protect(JsonSerializer.Serialize(
            new HistoryAnchor(window.SnapshotAt, null, null)), window.SnapshotAt.AddHours(1));
        return new(rows, cursor, start, window.PageSize, window.SnapshotAt);
    }
}
