import { Component, OnInit, inject, input } from "@angular/core";
import { DatePipe } from "@angular/common";
import { Api, Audit } from "./api";
import { CursorHistory, HistoryNavigationComponent } from "./pagination";

@Component({
  selector: "activity-history",
  standalone: true,
  imports: [DatePipe, HistoryNavigationComponent],
  template: `
    <section class="panel" [attr.aria-busy]="history.busy()">
      <div class="section-heading">
        <h2>Workspace change history</h2>
        <button
          class="text-button"
          (click)="history.refresh()"
          [disabled]="history.busy()"
        >
          Refresh activity
        </button>
      </div>
      <p class="muted mb-4 text-xs">
        Newest first. Refresh returns to the latest records. Older pages keep
        the same browsing cutoff.
      </p>
      <div class="table-scroll">
        <table class="invitation-history-table">
          <thead>
            <tr>
              <th>Change</th>
              <th>Subject</th>
              <th>Recorded at</th>
            </tr>
          </thead>
          <tbody>
            @for (a of history.items(); track a.id) {
              <tr>
                <td data-label="Change" class="max-md:col-span-2">
                  <code class="[overflow-wrap:anywhere]">{{ a.action }}</code>
                </td>
                <td
                  data-label="Subject"
                  class="max-md:col-span-2 [overflow-wrap:anywhere]"
                >
                  {{ a.subject }}
                </td>
                <td data-label="Recorded at" class="max-md:col-span-2">
                  {{ a.occurredAt | date: "medium" }}
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="3" class="max-md:col-span-2">
                  {{
                    history.busy()
                      ? "Loading history…"
                      : "No events in your current scope."
                  }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <history-navigation [history]="history" label="activity" />
      <p class="footnote">
        Times use your browser timezone; stored values are UTC. Only changes
        within your current school and branch permissions are included.
      </p>
    </section>
  `,
})
export class ActivityHistory implements OnInit {
  tenantId = input.required<string>();
  history = new CursorHistory<Audit>(
    inject(Api),
    () => `/api/tenants/${this.tenantId()}/audit`,
  );
  ngOnInit() {
    void this.history.refresh();
  }
}
