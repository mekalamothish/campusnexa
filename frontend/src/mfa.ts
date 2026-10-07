import { Component, OnInit, inject, output, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { DatePipe } from "@angular/common";
import { Api, errorMessage } from "./api";

@Component({
  selector: "mfa-challenge",
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="panel mx-auto my-10 max-w-lg">
      <span class="pill">SECOND STEP</span>
      <h1 class="mt-6">Verify your sign-in.</h1>
      <p class="muted text-sm">
        Enter a fresh authenticator code or one unused recovery code. This
        sign-in request expires after five minutes.
      </p>
      @if (error()) {
        <div class="alert error" role="alert">{{ error() }}</div>
      }
      <form (ngSubmit)="verify()">
        <fieldset [disabled]="busy()">
          <label for="mfa-method">Verification method</label
          ><select id="mfa-method" name="method" [(ngModel)]="recovery">
            <option [ngValue]="false">Authenticator app</option>
            <option [ngValue]="true">Recovery code</option>
          </select>
          <label for="mfa-code">Verification code</label
          ><input
            id="mfa-code"
            name="code"
            [(ngModel)]="code"
            autocomplete="one-time-code"
            [attr.inputmode]="recovery ? 'text' : 'numeric'"
            maxlength="100"
            required
          />
          <button class="primary full" [disabled]="busy()">
            Verify and sign in
          </button>
        </fieldset>
      </form>
      <a class="text-button inline-block mt-6" href="/">Restart sign-in</a>
    </section>
  `,
})
export class MfaChallenge {
  private api = inject(Api);
  verified = output<void>();
  busy = signal(false);
  error = signal("");
  code = "";
  recovery = false;
  async verify() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set("");
    try {
      await this.api.get("/api/auth/csrf");
      await this.api.post("/api/auth/mfa/verify", {
        code: this.code,
        recovery: this.recovery,
      });
      this.code = "";
      await this.api.get("/api/auth/csrf");
      this.verified.emit();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: "account-security",
  standalone: true,
  imports: [FormsModule, DatePipe],
  template: `
    <section class="panel max-w-2xl">
      <span class="pill">ACCOUNT-WIDE PROTECTION</span>
      <h2 class="mt-6">Authenticator app</h2>
      <p class="muted text-sm">
        Protect your sign-in across every school. Enrollment is optional in this
        local milestone. Your school roles and branch permissions do not change.
      </p>
      @if (error()) {
        <div class="alert error" role="alert">{{ error() }}</div>
      }
      @if (notice()) {
        <div class="alert success" role="status">{{ notice() }}</div>
      }
      @if (loaded()) {
        <p class="mt-5">
          <strong>MFA {{ enabled() ? "enabled" : "not enabled" }}</strong>
          @if (enabled()) {
            · {{ remaining() }} recovery codes remaining
          }
        </p>
        @if (codes().length) {
          <div class="alert success mt-5">
            <h3>Save your recovery codes now</h3>
            <p>
              Shown only once. Store these somewhere private outside this
              browser. Each code works once. New codes replace all previous
              ones.
            </p>
            <ul class="mt-4 space-y-2">
              @for (c of codes(); track c) {
                <li
                  class="font-mono text-xs break-all"
                  data-testid="recovery-code"
                >
                  {{ c }}
                </li>
              }
            </ul>
            <button class="secondary mt-4" (click)="codes.set([])">
              I saved my recovery codes
            </button>
          </div>
        }
        <form
          (ngSubmit)="
            act(enabled() ? 'recovery-codes' : key() ? 'enable' : 'setup')
          "
        >
          <fieldset [disabled]="busy()">
            <label for="security-password">Current password</label
            ><input
              id="security-password"
              name="password"
              type="password"
              [(ngModel)]="password"
              autocomplete="current-password"
              maxlength="256"
              required
            />
            @if (key()) {
              <div class="mt-4 rounded-xl border border-line p-4">
                <h3>Add an account in your authenticator app</h3>
                <p class="footnote">
                  Choose manual entry, name it CampusNexa, select a time-based
                  code, and enter this setup key. Keep it private.
                </p>
                <code
                  class="block break-all font-mono text-sm"
                  data-testid="setup-key"
                  >{{ key() }}</code
                >
              </div>
            }
            @if (enabled() || key()) {
              @if (enabled()) {
                <label for="security-method">Second-factor method</label
                ><select
                  id="security-method"
                  name="recovery"
                  [(ngModel)]="recovery"
                >
                  <option [ngValue]="false">Authenticator app</option>
                  <option [ngValue]="true">Unused recovery code</option>
                </select>
              }
              <label for="security-code">Security code</label
              ><input
                id="security-code"
                name="code"
                [(ngModel)]="code"
                autocomplete="one-time-code"
                maxlength="100"
                required
              />
              <p class="field-hint">
                Use a fresh authenticator code. A code already used for sign-in
                or setup cannot be reused.
              </p>
            }
            <button class="primary mt-5" [disabled]="busy()">
              {{
                enabled()
                  ? "Replace recovery codes"
                  : key()
                    ? "Enable MFA"
                    : "Set up authenticator"
              }}
            </button>
            @if (enabled()) {
              <label class="mt-5 flex items-center gap-3"
                ><input
                  class="!w-auto"
                  name="confirmDisable"
                  type="checkbox"
                  [(ngModel)]="confirmDisable"
                />I understand disabling MFA removes second-step
                protection.</label
              >
              <button
                type="button"
                class="secondary mt-4"
                [disabled]="busy() || !confirmDisable"
                (click)="act('disable')"
              >
                Disable MFA
              </button>
            }
          </fieldset>
        </form>
        <p class="footnote">
          Security changes sign out other sessions. Password recovery does not
          remove MFA. If you lose both your authenticator and all recovery
          codes, there is no support bypass in this milestone.
        </p>
      } @else if (!error()) {
        <p role="status">Loading account security…</p>
      }
    </section>
    <section class="panel max-w-2xl mt-6" data-testid="security-history">
      <div class="section-heading">
        <h2>Security history</h2>
        <button
          class="text-button"
          (click)="loadHistory()"
          [disabled]="historyBusy()"
        >
          Refresh security history
        </button>
      </div>
      <p class="muted text-sm">
        Your account across all schools. Only you can view these entries,
        regardless of school roles. Latest 100 events, newest first.
      </p>
      @if (historyError()) {
        <p class="alert error" role="alert">{{ historyError() }}</p>
      }
      @if (historyBusy()) {
        <p class="footnote">Loading security history…</p>
      }
      <div class="table-scroll">
        <table class="table-fixed whitespace-normal">
          <thead>
            <tr>
              <th>Event</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            @for (event of history(); track event.id) {
              <tr>
                <td>{{ eventLabel(event.action) }}</td>
                <td>{{ event.occurredAt | date: "medium" }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="2">No recorded security events yet.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <p class="footnote">
        Times use your browser timezone. No passwords, codes, IP addresses or
        device details are recorded here. Unknown-account and unattributable
        requests are not listed. This is not a complete intrusion-detection log.
      </p>
    </section>
  `,
})
export class AccountSecurity implements OnInit {
  private api = inject(Api);
  enabled = signal(false);
  remaining = signal(0);
  loaded = signal(false);
  busy = signal(false);
  error = signal("");
  notice = signal("");
  key = signal("");
  codes = signal<string[]>([]);
  password = "";
  code = "";
  recovery = false;
  confirmDisable = false;
  history = signal<{ id: string; action: string; occurredAt: string }[]>([]);
  historyBusy = signal(false);
  historyError = signal("");
  async ngOnInit() {
    await this.load();
    await this.loadHistory();
  }
  async loadHistory() {
    this.historyBusy.set(true);
    this.historyError.set("");
    try {
      this.history.set(
        await this.api.get<
          { id: string; action: string; occurredAt: string }[]
        >("/api/auth/security-events"),
      );
    } catch (e) {
      this.historyError.set(errorMessage(e));
    } finally {
      this.historyBusy.set(false);
    }
  }
  eventLabel(action: string) {
    return (
      (
        {
          PasswordSignIn: "Password sign-in",
          SignInFailed: "Sign-in attempt failed",
          MfaChallengeStarted: "Second-step sign-in requested",
          MfaSignIn: "Authenticator sign-in",
          RecoveryCodeSignIn: "Recovery-code sign-in",
          MfaVerificationFailed: "Second-step verification failed",
          MfaSetupStarted: "Authenticator setup started",
          MfaEnabled: "Authenticator enabled",
          MfaDisabled: "Authenticator disabled",
          RecoveryCodesReplaced: "Recovery codes replaced",
          MfaManagementFailed: "Security change verification failed",
          PasswordRecoveryRequested: "Password recovery requested",
          RecoveryDeliveryFailed: "Local recovery email failed",
          PasswordReset: "Password reset completed",
          PasswordResetFailed: "Password reset attempt failed",
          SignedOut: "Signed out",
          SessionsRevoked: "All sessions revoked",
          AuthenticatorKeyProtected: "Authenticator storage encrypted",
        } as Record<string, string>
      )[action] ?? action
    );
  }
  async load() {
    try {
      const state = await this.api.get<{
        enabled: boolean;
        recoveryCodesRemaining: number;
      }>("/api/auth/mfa/status");
      this.enabled.set(state.enabled);
      this.remaining.set(state.recoveryCodesRemaining);
      this.loaded.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
  async act(action: string) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set("");
    this.notice.set("");
    this.codes.set([]);
    try {
      await this.api.get("/api/auth/csrf");
      const result = await this.api.post<{
        sharedKey?: string;
        recoveryCodes?: string[];
      }>("/api/auth/mfa/" + action, {
        password: this.password,
        code: this.code,
        recovery: this.recovery,
      });
      await this.api.get("/api/auth/csrf");
      this.code = "";
      this.password = "";
      this.confirmDisable = false;
      if (action === "setup") {
        this.key.set(result.sharedKey!);
        this.notice.set(
          "Add the setup key to your authenticator, then re-enter your password and a code to enable MFA.",
        );
      } else {
        this.key.set("");
        this.codes.set(result.recoveryCodes ?? []);
        this.notice.set(
          action === "disable"
            ? "MFA disabled. Other sessions have been signed out."
            : "Security updated. Save the recovery codes before leaving this page.",
        );
      }
      await this.load();
      await this.loadHistory();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
