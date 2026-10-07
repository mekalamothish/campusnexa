import {
  Component,
  HostListener,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { HttpErrorResponse } from "@angular/common/http";
import { FormsModule } from "@angular/forms";
import { InvitationManager, AcceptInvitation } from "./invitations";
import { ActivityHistory } from "./activity";
import { PasswordRecovery } from "./recovery";
import { MfaChallenge, AccountSecurity } from "./mfa";
import {
  Page,
  canOpenPage,
  readWorkspacePath,
  workspacePath,
} from "./navigation";
import {
  Api,
  Branch,
  Member,
  Membership,
  Module,
  Overview,
  Settings,
  User,
  errorMessage,
} from "./api";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [
    FormsModule,
    DatePipe,
    InvitationManager,
    ActivityHistory,
    AcceptInvitation,
    PasswordRecovery,
    MfaChallenge,
    AccountSecurity,
  ],
  templateUrl: "./app.html",
})
export class AppComponent implements OnInit {
  private api = inject(Api);
  private activityHistory = viewChild(ActivityHistory);
  mfaPending = signal(false);
  inviteToken = signal("");
  recovery = signal<{ token: string; email: string } | null>(null);
  @HostListener("window:hashchange") openInvitationLink() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    if (params.has("reset") || params.has("recover")) {
      ++this.viewVersion;
      this.inviteToken.set("");
      this.recovery.set({
        token: params.get("reset") ?? "",
        email: params.get("email") ?? "",
      });
      window.history.replaceState(null, "", window.location.pathname);
    } else if (params.get("invite")) {
      ++this.viewVersion;
      this.recovery.set(null);
      this.inviteToken.set(params.get("invite")!);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }
  readonly nav: Page[] = [
    "Overview",
    "Branches",
    "People & access",
    "Modules",
    "Activity log",
    "Settings",
    "Account security",
  ];
  readonly navIcons = ["◈", "⊞", "♙", "▦", "◷", "⚙", "◇"];
  user = signal<User | null>(null);
  membership = signal<Membership | null>(null);
  page = signal<Page>("Overview");
  booting = signal(true);
  busy = signal(false);
  error = signal("");
  notice = signal("");
  branches = signal<Branch[]>([]);
  members = signal<Member[]>([]);
  modules = signal<Module[]>([]);
  overview = signal<Overview | null>(null);
  settings = signal<Settings | null>(null);
  settingsConflict = signal(false);
  branchSettingsConflict = signal(false);
  private viewVersion = 0;
  isAdmin = computed(() => this.membership()?.role === "OrganizationAdmin");
  canManage = computed(() => this.membership()?.role !== "Viewer");
  email = "";
  password = "";
  branchName = "";
  branchCode = "";
  settingsForm: Settings = {
    version: "",
    displayName: "",
    timeZone: "UTC",
    locale: "en-US",
    currency: "USD",
    academicYearLabel: "Not configured",
  };
  selectedBranch = "";
  branchTimeZone = "";
  branchLocale = "";
  branchCurrency = "";
  private base() {
    return `/api/tenants/${this.membership()!.tenantId}`;
  }
  async ngOnInit() {
    this.openInvitationLink();
    if (this.inviteToken() || this.recovery()) {
      this.booting.set(false);
      return;
    }
    try {
      await this.api.get("/api/auth/csrf");
      await this.loadUser();
    } catch (e) {
      // Only an anonymous 401 is expected. Surface service failures instead of silently hiding them.
      if (!(e && typeof e === "object" && "status" in e && e.status === 401))
        this.error.set(errorMessage(e));
    } finally {
      this.booting.set(false);
    }
  }
  private async loadUser() {
    const user = await this.api.get<User>("/api/auth/me");
    this.user.set(user);
    this.membership.set(user.memberships[0] ?? null);
    await this.api.get("/api/auth/csrf");
    if (this.membership()) await this.restoreLocation();
  }
  @HostListener("window:popstate")
  async restoreLocation() {
    const user = this.user();
    if (!user || this.inviteToken() || this.recovery() || this.mfaPending())
      return;
    const requested = readWorkspacePath(window.location.pathname);
    const allowed = user.memberships.find(
      (m) => m.tenantId === requested?.tenantId,
    );
    const unavailable =
      window.location.pathname !== "/" &&
      (!requested || !allowed || !canOpenPage(allowed.role, requested.page));
    const membership =
      unavailable || !requested ? user.memberships[0] : allowed;
    this.membership.set(membership ?? null);
    this.page.set(unavailable || !requested ? "Overview" : requested.page);
    this.notice.set("");
    this.writeLocation(true);
    const view = this.viewVersion + 1;
    if (membership) await this.load();
    if (unavailable && view === this.viewVersion)
      this.error.set(
        "That workspace page is unavailable for your account. Your permitted workspace is shown.",
      );
  }
  private writeLocation(replace = false) {
    const member = this.membership();
    const url = member ? workspacePath(member.tenantId, this.page()) : "/";
    document.title = member ? `${this.page()} · CampusNexa` : "CampusNexa";
    if (
      window.location.pathname === url &&
      !window.location.search &&
      !window.location.hash
    )
      return;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }
  async login() {
    this.busy.set(true);
    this.error.set("");
    try {
      await this.api.get("/api/auth/csrf");
      const result = await this.api.post<{ requiresMfa?: boolean } | null>(
        "/api/auth/login",
        {
          email: this.email,
          password: this.password,
        },
      );
      this.password = "";
      if (result?.requiresMfa) {
        this.user.set(null);
        this.mfaPending.set(true);
        await this.api.get("/api/auth/csrf");
        return;
      }
      await this.loadUser();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
  async logout(all = false) {
    ++this.viewVersion;
    this.busy.set(true);
    this.error.set("");
    try {
      await this.api.post(
        all ? "/api/auth/revoke-sessions" : "/api/auth/logout",
      );
      this.user.set(null);
      this.membership.set(null);
      this.writeLocation(true);
      this.notice.set("");
      this.page.set("Overview");
      this.branches.set([]);
      this.members.set([]);
      this.overview.set(null);
      this.settings.set(null);
      await this.api.get("/api/auth/csrf");
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
  async finishMfa() {
    this.mfaPending.set(false);
    try {
      await this.loadUser();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  async switchTenant(id: string) {
    const member = this.user()?.memberships.find((m) => m.tenantId === id);
    if (!member) return;
    this.membership.set(member);
    this.page.set("Overview");
    this.notice.set("");
    this.writeLocation();
    await this.load();
  }
  async navigate(page: Page) {
    if (!canOpenPage(this.membership()?.role ?? "", page)) return;
    this.page.set(page);
    this.notice.set("");
    this.writeLocation();
    await this.load();
  }
  async load() {
    const view = ++this.viewVersion;
    const current = () => view === this.viewVersion;
    this.busy.set(true);
    this.error.set("");
    this.branches.set([]);
    this.members.set([]);
    this.modules.set([]);
    this.overview.set(null);
    this.settings.set(null);
    this.settingsConflict.set(false);
    this.branchSettingsConflict.set(false);
    try {
      if (this.page() === "Account security") return;
      const base = this.base();
      switch (this.page()) {
        case "Overview":
          const overview = await this.api.get<Overview>(base + "/overview");
          if (current()) this.overview.set(overview);
          break;
        case "Branches":
          const branches = await this.api.get<Branch[]>(base + "/branches");
          if (current()) this.branches.set(branches);
          break;
        case "People & access":
          const members = await this.api.get<Member[]>(base + "/members");
          if (current()) this.members.set(members);
          break;
        case "Modules":
          const modules = await this.api.get<Module[]>(base + "/modules");
          if (current()) this.modules.set(modules);
          break;
        case "Activity log":
          // The scoped history component owns its cursor state and requests.
          await this.activityHistory()?.history.refresh();
          break;
        case "Settings": {
          const [s, b] = await Promise.all([
            this.api.get<Settings>(base + "/settings"),
            this.api.get<Branch[]>(base + "/branches"),
          ]);
          if (!current()) return;
          this.settings.set(s);
          this.settingsForm = { ...s };
          this.branches.set(b);
          this.selectBranch(b[0]?.id ?? "");
          break;
        }
      }
    } catch (e) {
      if (current()) this.error.set(errorMessage(e));
    } finally {
      if (current()) this.busy.set(false);
    }
  }
  async createBranch() {
    if (this.busy()) return;
    const view = this.viewVersion;
    this.busy.set(true);
    this.error.set("");
    try {
      await this.api.post(this.base() + "/branches", {
        name: this.branchName,
        code: this.branchCode,
      });
      if (view !== this.viewVersion) return;
      this.branchName = "";
      this.branchCode = "";
      await this.load();
      if (this.viewVersion !== view + 1) return;
      this.notice.set(
        "Branch created. Organization preferences are inherited automatically.",
      );
    } catch (e) {
      if (view === this.viewVersion) this.error.set(errorMessage(e));
    } finally {
      if (view === this.viewVersion) this.busy.set(false);
    }
  }
  async saveSettings() {
    if (this.busy() || this.settingsConflict()) return;
    const view = this.viewVersion;
    this.busy.set(true);
    this.error.set("");
    this.notice.set("");
    try {
      const saved = await this.api.put<Settings>(this.base() + "/settings", {
        ...this.settingsForm,
      });
      if (view !== this.viewVersion) return;
      this.settings.set(saved);
      this.settingsForm = { ...saved };
      this.notice.set("Organization preferences saved.");
    } catch (e) {
      if (view !== this.viewVersion) return;
      if (e instanceof HttpErrorResponse && [409, 428].includes(e.status))
        this.settingsConflict.set(true);
      this.error.set(errorMessage(e));
    } finally {
      if (view === this.viewVersion) this.busy.set(false);
    }
  }
  selectBranch(id: string) {
    this.selectedBranch = id;
    this.branchSettingsConflict.set(false);
    const b = this.branches().find((x) => x.id === id);
    this.branchTimeZone = b?.timeZoneOverride ?? "";
    this.branchLocale = b?.localeOverride ?? "";
    this.branchCurrency = b?.currencyOverride ?? "";
  }
  async saveBranchSettings() {
    if (this.busy() || this.branchSettingsConflict()) return;
    const view = this.viewVersion;
    const id = this.selectedBranch;
    this.busy.set(true);
    this.error.set("");
    this.notice.set("");
    try {
      const saved = await this.api.put<Branch>(
        this.base() + `/branches/${id}/settings`,
        {
          version: this.branches().find((b) => b.id === id)?.version,
          timeZone: this.branchTimeZone.trim() || null,
          locale: this.branchLocale.trim() || null,
          currency: this.branchCurrency.trim() || null,
        },
      );
      if (view !== this.viewVersion || id !== this.selectedBranch) return;
      this.branches.update((rows) =>
        rows.map((b) => (b.id === id ? saved : b)),
      );
      this.selectBranch(id);
      this.notice.set(
        "Branch overrides saved. Empty fields inherit organization preferences.",
      );
    } catch (e) {
      if (view !== this.viewVersion || id !== this.selectedBranch) return;
      if (e instanceof HttpErrorResponse && [409, 428].includes(e.status))
        this.branchSettingsConflict.set(true);
      this.error.set(errorMessage(e));
    } finally {
      if (view === this.viewVersion) this.busy.set(false);
    }
  }
  async reloadSettings(branch = false) {
    if (this.busy()) return;
    const view = this.viewVersion,
      id = this.selectedBranch;
    this.busy.set(true);
    this.error.set("");
    this.notice.set("");
    try {
      if (branch) {
        const [saved, defaults] = await Promise.all([
          this.api.get<Branch>(this.base() + `/branches/${id}`),
          this.api.get<Settings>(this.base() + "/settings"),
        ]);
        if (view !== this.viewVersion || id !== this.selectedBranch) return;
        this.branches.update((rows) =>
          rows.map((b) => (b.id === id ? saved : b)),
        );
        // Update inheritance hints without discarding a separate organization draft.
        this.settings.set(defaults);
        this.selectBranch(id);
      } else {
        const saved = await this.api.get<Settings>(this.base() + "/settings");
        if (view !== this.viewVersion) return;
        this.settings.set(saved);
        this.settingsForm = { ...saved };
        this.settingsConflict.set(false);
      }
      this.notice.set(
        "Saved values reloaded. Review them before making changes.",
      );
    } catch (e) {
      if (view === this.viewVersion) this.error.set(errorMessage(e));
    } finally {
      if (view === this.viewVersion) this.busy.set(false);
    }
  }
  roleLabel(role: string) {
    return role.replace(/([a-z])([A-Z])/g, "$1 $2");
  }
  moduleDescription(name: string) {
    return (
      (
        {
          platform: "Organizations, branches, access and preferences",
          academics: "Classes, timetables, attendance and examinations",
          finance: "Fee structures, collections and reconciliation",
          communication: "Announcements, messages and parent engagement",
          campus: "Library, transport, hostel and campus services",
          reports: "Operational reporting and school insights",
        } as Record<string, string>
      )[name] ?? name
    );
  }
}
