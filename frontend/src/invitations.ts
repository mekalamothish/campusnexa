import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnInit,
  inject,
  input,
  signal,
  viewChild,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { DatePipe } from "@angular/common";
import { Api, Branch, errorMessage } from "./api";
import { MfaChallenge } from "./mfa";
import { CursorHistory, HistoryNavigationComponent } from "./pagination";

interface Invite {
  id: string;
  email: string;
  role: string;
  branchId: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  delivery: {
    status: string;
    attempts: number;
    nextAttemptAt: string | null;
    completedAt: string | null;
  } | null;
}
interface Preview {
  organization: string;
  email: string;
  role: string;
  expiresAt: string;
  requiresSignIn: boolean;
}

@Component({
  selector: "invitation-manager",
  standalone: true,
  imports: [FormsModule, DatePipe, HistoryNavigationComponent],
  template: `
    <section class="panel mt-6">
      <div class="section-heading">
        <div>
          <h2>Invite people</h2>
          <p class="muted mt-2 text-xs">
            Links expire after 48 hours. Only organization administrators can
            send invitations.
          </p>
        </div>
        <span class="pill">LOCAL TEST EMAIL</span>
      </div>
      @if (error()) {
        <div class="alert error" role="alert">{{ error() }}</div>
      }
      @if (notice()) {
        <div class="alert success" role="status">{{ notice() }}</div>
      }
      <form (ngSubmit)="send()">
        <fieldset [disabled]="working()">
          <div class="form-grid">
            <div>
              <label for="invite-email">Invite email</label
              ><input
                id="invite-email"
                name="email"
                type="email"
                [(ngModel)]="email"
                required
                maxlength="254"
                placeholder="person@school.edu"
              />
            </div>
            <div>
              <label for="invite-role">Invite role</label
              ><select id="invite-role" name="role" [(ngModel)]="role">
                <option value="Viewer">Viewer</option>
                <option value="BranchAdmin">Branch administrator</option>
                <option value="OrganizationAdmin">
                  Organization administrator
                </option>
              </select>
            </div>
            @if (role !== "OrganizationAdmin") {
              <div>
                <label for="invite-branch">Assigned branch</label
                ><select
                  id="invite-branch"
                  name="branchId"
                  [(ngModel)]="branchId"
                  required
                >
                  <option value="">Choose a branch</option>
                  @for (b of branches(); track b.id) {
                    <option [value]="b.id">{{ b.name }}</option>
                  }
                </select>
              </div>
            }
          </div>
          <button class="primary" [disabled]="working()">
            Send invitation
          </button>
        </fieldset>
      </form>
      <p class="footnote">
        Emails are captured in the local test inbox at 127.0.0.1:8025. They are
        not delivered to real addresses.
      </p>
    </section>
    <section class="panel mt-6">
      <div class="section-heading">
        <h2>Invitation history</h2>
        <button class="text-button" (click)="load()" [disabled]="working()">
          Refresh invitations
        </button>
      </div>
      <p class="muted mb-4 text-xs">
        Delivery status is separate from invitation acceptance. Sent to test
        inbox means accepted by local mail, not read by the recipient. Refresh
        to update.
      </p>
      @if (retryTarget(); as target) {
        <div
          #retryConfirmation
          class="alert border border-line bg-canvas [overflow-wrap:anywhere]"
          role="region"
          aria-label="Confirm delivery retry"
          tabindex="-1"
        >
          <p>
            Retry delivery for <strong>{{ target.email }}</strong
            >? This revokes the old link and queues a fresh one with the same
            role, branch and expiry ({{ target.expiresAt | date: "medium" }}).
          </p>
          <div class="mt-3 flex flex-wrap gap-3">
            <button
              class="primary"
              (click)="retry(target)"
              [disabled]="working()"
            >
              Confirm retry
            </button>
            <button
              class="text-button"
              (click)="cancelRetry()"
              [disabled]="working()"
            >
              Cancel retry
            </button>
          </div>
        </div>
      }
      <div class="table-scroll">
        <table class="invitation-history-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Email delivery</th>
              <th>Expires</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            @for (i of invitations(); track i.id) {
              <tr>
                <td data-label="Email" class="max-md:col-span-2">
                  {{ i.email }}
                </td>
                <td data-label="Role">{{ i.role }}</td>
                <td data-label="Status">{{ status(i) }}</td>
                <td data-label="Email delivery" class="max-md:col-span-2">
                  <span>{{ deliveryLabel(i) }}</span>
                  @if (i.delivery; as d) {
                    <span class="muted mt-1 block text-xs"
                      >Attempts: {{ d.attempts }} / 5</span
                    >
                    @if (d.status === "Pending" && d.attempts > 0) {
                      <span class="muted mt-1 block text-xs">
                        Next attempt no earlier than
                        {{ d.nextAttemptAt | date: "medium" }}
                      </span>
                    }
                    @if (d.completedAt) {
                      <span class="muted mt-1 block text-xs">{{
                        d.completedAt | date: "medium"
                      }}</span>
                    }
                  }
                </td>
                <td data-label="Expires" class="max-md:col-span-2">
                  {{ i.expiresAt | date: "medium" }}
                </td>
                <td data-label="Action" class="max-md:col-span-2">
                  @if (canRetry(i)) {
                    <button
                      class="text-button mr-3"
                      [attr.aria-label]="'Retry delivery for ' + i.email"
                      (click)="askRetry(i, $event)"
                      [disabled]="working()"
                    >
                      Retry delivery
                    </button>
                  }
                  @if (!i.acceptedAt && !i.revokedAt) {
                    <button
                      class="text-button"
                      [attr.aria-label]="'Revoke invitation for ' + i.email"
                      (click)="revoke(i)"
                      [disabled]="working()"
                    >
                      Revoke
                    </button>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="6" class="max-md:col-span-2">
                  {{
                    history.busy()
                      ? "Loading invitations…"
                      : "No invitations yet."
                  }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <history-navigation
        [history]="history"
        label="invitations"
        [disabled]="busy() || retryTarget() !== null"
      />
      <p class="footnote">
        Newest first, 25 per page. Refresh returns to the latest invitations.
        Revoking a pending invitation does not remove an existing membership.
        Failed delivery can be retried only while its invitation is still
        pending and unexpired. Older invitations without delivery tracking show
        Not tracked.
      </p>
    </section>
  `,
})
export class InvitationManager implements OnInit {
  tenantId = input.required<string>();
  private api = inject(Api);
  history = new CursorHistory<Invite>(
    this.api,
    () => this.base() + "/invitations",
  );
  invitations = this.history.items;
  branches = signal<Branch[]>([]);
  error = signal("");
  notice = signal("");
  busy = signal(false);
  working = () => this.busy() || this.history.busy();
  retryTarget = signal<Invite | null>(null);
  private retryConfirmation =
    viewChild<ElementRef<HTMLElement>>("retryConfirmation");
  private changeDetector = inject(ChangeDetectorRef);
  private retryButton: HTMLElement | null = null;
  email = "";
  role = "Viewer";
  branchId = "";
  private base() {
    return "/api/tenants/" + this.tenantId();
  }
  ngOnInit() {
    void this.load();
  }
  async load() {
    this.busy.set(true);
    this.retryTarget.set(null);
    this.error.set("");
    try {
      const [, b] = await Promise.all([
        this.history.refresh(),
        this.api.get<Branch[]>(this.base() + "/branches"),
      ]);
      this.branches.set(b);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
  status(i: Invite) {
    return i.acceptedAt
      ? "Accepted"
      : i.revokedAt
        ? "Revoked"
        : new Date(i.expiresAt) < new Date()
          ? "Expired"
          : "Pending";
  }
  deliveryLabel(i: Invite) {
    switch (i.delivery?.status) {
      case "Pending":
        return i.delivery.attempts ? "Retry scheduled" : "Queued";
      case "Sent":
        return "Sent to test inbox";
      case "Dead":
        return "Failed";
      case "Expired":
        return "Expired before delivery";
      case "Cancelled":
        return "Cancelled";
      default:
        return "Not tracked";
    }
  }
  canRetry(i: Invite) {
    return (
      i.delivery?.status === "Dead" &&
      !i.acceptedAt &&
      !i.revokedAt &&
      new Date(i.expiresAt).getTime() > Date.now()
    );
  }
  askRetry(i: Invite, event: Event) {
    this.retryButton = event.currentTarget as HTMLElement;
    this.retryTarget.set(i);
    this.changeDetector.detectChanges();
    this.retryConfirmation()?.nativeElement.focus();
  }
  cancelRetry() {
    this.retryTarget.set(null);
    this.retryButton?.focus();
  }
  async retry(i: Invite) {
    if (this.working()) return;
    this.busy.set(true);
    this.error.set("");
    this.notice.set("");
    try {
      await this.api.post(
        this.base() + "/invitations/" + i.id + "/retry-delivery",
      );
      await this.load();
      this.notice.set(
        "Replacement invitation queued. The old link is revoked; the original expiry is unchanged.",
      );
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
  async send() {
    this.busy.set(true);
    this.error.set("");
    this.notice.set("");
    try {
      await this.api.post(this.base() + "/invitations", {
        email: this.email,
        role: this.role,
        branchId: this.role === "OrganizationAdmin" ? null : this.branchId,
      });
      this.email = "";
      await this.load();
      this.notice.set("Invitation queued. Check the local test inbox shortly.");
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
  async revoke(i: Invite) {
    this.busy.set(true);
    this.error.set("");
    this.notice.set("");
    try {
      await this.api.post(this.base() + "/invitations/" + i.id + "/revoke");
      await this.load();
      this.notice.set("Invitation revoked. Its link can no longer be used.");
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "accept-invitation",
  standalone: true,
  imports: [FormsModule, DatePipe, MfaChallenge],
  template: `
    <main class="min-h-screen px-5 py-12">
      <div class="mx-auto max-w-lg">
        <a class="brand mb-8" href="/"
          ><span class="brand-mark">N</span>CampusNexa</a
        >
        <section class="panel">
          <span class="pill">WORKSPACE INVITATION</span>
          <h1 class="mt-6">You're invited.</h1>
          @if (error()) {
            <div class="alert error" role="alert">{{ error() }}</div>
          }
          @if (done()) {
            <div class="alert success" role="status">
              Invitation accepted. Your account can now access this
              organization.
            </div>
            <a class="primary" href="/">Continue to sign in</a>
          } @else if (preview(); as i) {
            <h2>{{ i.organization }}</h2>
            <p class="muted text-sm">
              Invited email: <strong>{{ i.email }}</strong
              ><br />Role: {{ i.role }}<br />Expires:
              {{ i.expiresAt | date: "medium" }}
            </p>
            @if (i.requiresSignIn) {
              <p class="footnote">
                This email already has an account. Sign in with that account
                before joining; its password will not be changed.
              </p>
              <form (ngSubmit)="signIn()">
                <label for="existing-password">Existing account password</label
                ><input
                  id="existing-password"
                  name="password"
                  type="password"
                  [(ngModel)]="password"
                  autocomplete="current-password"
                  required
                /><button class="primary" [disabled]="busy()">
                  Sign in to invited account
                </button>
              </form>
              @if (mfaPending()) {
                <mfa-challenge
                  (verified)="mfaPending.set(false); signedIn.set(true)"
                />
              }
              @if (signedIn()) {
                <p class="alert success mt-4" role="status">
                  Signed in. You can now accept the invitation.
                </p>
              }
              <button
                class="secondary mt-5"
                (click)="accept()"
                [disabled]="busy()"
              >
                Accept invitation
              </button>
            } @else {
              <form (ngSubmit)="accept()">
                <label for="new-name">Your full name</label
                ><input
                  id="new-name"
                  name="displayName"
                  [(ngModel)]="displayName"
                  maxlength="120"
                  autocomplete="name"
                  required
                /><label for="new-password">Create password</label
                ><input
                  id="new-password"
                  name="password"
                  type="password"
                  [(ngModel)]="password"
                  minlength="12"
                  maxlength="256"
                  autocomplete="new-password"
                  required
                />
                <p class="field-hint">
                  At least 12 characters with upper/lower case, a number and a
                  symbol.
                </p>
                <button class="primary" [disabled]="busy()">
                  Create account and join
                </button>
              </form>
            }
            <button
              class="text-button mt-4"
              (click)="signOut()"
              [disabled]="busy()"
            >
              Sign out current account
            </button>
          } @else if (busy()) {
            <p role="status">Checking your invitation…</p>
          }
          <p class="footnote">
            This is a local development environment. Do not use real school
            information.
          </p>
        </section>
      </div>
    </main>
  `,
})
export class AcceptInvitation implements OnInit {
  mfaPending = signal(false);
  token = input.required<string>();
  private api = inject(Api);
  preview = signal<Preview | null>(null);
  busy = signal(false);
  error = signal("");
  done = signal(false);
  signedIn = signal(false);
  displayName = "";
  password = "";
  async ngOnInit() {
    this.busy.set(true);
    try {
      await this.api.get("/api/auth/csrf");
      this.preview.set(
        await this.api.post<Preview>("/api/invitations/preview", {
          token: this.token(),
        }),
      );
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
  async signIn() {
    this.busy.set(true);
    this.error.set("");
    this.signedIn.set(false);
    try {
      const result = await this.api.post<{ requiresMfa?: boolean } | null>(
        "/api/auth/login",
        { email: this.preview()!.email, password: this.password },
      );
      this.password = "";
      await this.api.get("/api/auth/csrf");
      this.mfaPending.set(!!result?.requiresMfa);
      this.signedIn.set(!result?.requiresMfa);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
  async signOut() {
    this.busy.set(true);
    this.error.set("");
    try {
      try {
        await this.api.post("/api/auth/logout");
      } catch (e) {
        if (!(e && typeof e === "object" && "status" in e && e.status === 401))
          throw e;
      }
      await this.api.get("/api/auth/csrf");
      this.signedIn.set(false);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
  async accept() {
    this.busy.set(true);
    this.error.set("");
    try {
      await this.api.post("/api/invitations/accept", {
        token: this.token(),
        displayName: this.displayName,
        password: this.preview()!.requiresSignIn ? null : this.password,
      });
      this.password = "";
      this.done.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
