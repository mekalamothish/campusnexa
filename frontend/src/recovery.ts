import { Component, inject, input, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Api, errorMessage } from "./api";

@Component({
  selector: "password-recovery",
  standalone: true,
  imports: [FormsModule],
  template: `
    <main class="min-h-screen px-5 py-12">
      <div class="mx-auto max-w-lg">
        <a class="brand mb-8" href="/"
          ><span class="brand-mark">N</span>CampusNexa</a
        >
        <section class="panel">
          <span class="pill">ACCOUNT RECOVERY</span>
          <h1 class="mt-6">
            {{ token() ? "Choose a new password." : "Forgot your password?" }}
          </h1>
          <p class="muted text-sm">
            {{
              token()
                ? "This changes your account password across all your schools and signs out existing sessions."
                : "Enter your account email. Recovery links expire after 30 minutes."
            }}
          </p>
          @if (error()) {
            <div class="alert error" role="alert">{{ error() }}</div>
          }
          @if (notice()) {
            <div class="alert success" role="status">{{ notice() }}</div>
          }
          @if (!done()) {
            <form (ngSubmit)="submit()">
              <fieldset [disabled]="busy()">
                @if (!token()) {
                  <label for="recovery-email">Account email</label>
                  <input
                    id="recovery-email"
                    name="email"
                    type="email"
                    [(ngModel)]="email"
                    autocomplete="username"
                    maxlength="254"
                    required
                  />
                } @else {
                  <p class="footnote break-all">
                    Account: {{ accountEmail() }}
                  </p>
                  <label for="reset-password">New password</label>
                  <input
                    id="reset-password"
                    name="password"
                    type="password"
                    [(ngModel)]="password"
                    autocomplete="new-password"
                    minlength="12"
                    maxlength="256"
                    required
                  />
                  <label for="confirm-password">Confirm new password</label>
                  <input
                    id="confirm-password"
                    name="confirmation"
                    type="password"
                    [(ngModel)]="confirmation"
                    autocomplete="new-password"
                    minlength="12"
                    maxlength="256"
                    required
                  />
                  <p class="field-hint">
                    12–256 characters with upper/lower case, a number and a
                    symbol.
                  </p>
                }
                <button class="primary full" [disabled]="busy()">
                  {{
                    busy()
                      ? "Please wait…"
                      : token()
                        ? "Reset password"
                        : "Send recovery link"
                  }}
                </button>
              </fieldset>
            </form>
          }
          <a class="text-button mt-6 inline-block" href="/">Back to sign in</a>
          @if (token() && !done()) {
            <a class="text-button mt-4 block" href="/#recover"
              >Request a new recovery link</a
            >
          }
          <p class="footnote">
            Local development only. Emails appear in the test inbox at
            127.0.0.1:8025, not in your real mailbox.
          </p>
        </section>
      </div>
    </main>
  `,
})
export class PasswordRecovery {
  token = input("");
  accountEmail = input("");
  private api = inject(Api);
  email = "";
  password = "";
  confirmation = "";
  busy = signal(false);
  error = signal("");
  notice = signal("");
  done = signal(false);
  async submit() {
    if (this.busy()) return;
    this.error.set("");
    this.notice.set("");
    if (this.token() && this.password !== this.confirmation) {
      this.error.set("The passwords do not match.");
      return;
    }
    this.busy.set(true);
    try {
      await this.api.get("/api/auth/csrf");
      const result = this.token()
        ? await this.api.post<{ message: string }>("/api/auth/reset-password", {
            email: this.accountEmail(),
            token: this.token(),
            password: this.password,
          })
        : await this.api.post<{ message: string }>(
            "/api/auth/forgot-password",
            { email: this.email },
          );
      this.password = "";
      this.confirmation = "";
      this.notice.set(result.message);
      this.done.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
