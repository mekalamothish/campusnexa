import {
  Component,
  DestroyRef,
  Signal,
  inject,
  input,
  signal,
} from "@angular/core";
import { Api, errorMessage } from "./api";

export interface HistoryPage<T> {
  items: T[];
  nextCursor: string | null;
  startCursor: string;
  pageSize: number;
  snapshotAt: string;
}

// Only the current page and cursor trail are kept in memory. Older failed requests
// and responses arriving after navigation cannot replace the visible page.
export class CursorHistory<T> {
  readonly items = signal<T[]>([]);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly pageNumber = signal(1);
  readonly nextCursor = signal<string | null>(null);
  private trail: (string | null)[] = [null];
  private version = 0;
  constructor(
    private api: Api,
    private path: () => string,
  ) {
    inject(DestroyRef).onDestroy(() => this.version++);
  }
  refresh() {
    return this.fetch([null]);
  }
  async next() {
    const cursor = this.nextCursor();
    if (this.busy() || !cursor) return;
    await this.fetch([...this.trail, cursor]);
  }
  async previous() {
    if (this.busy() || this.trail.length < 2) return;
    await this.fetch(this.trail.slice(0, -1));
  }
  private async fetch(trail: (string | null)[]) {
    const version = ++this.version;
    this.busy.set(true);
    this.error.set("");
    try {
      const cursor = trail[trail.length - 1];
      const page = await this.api.get<HistoryPage<T>>(
        this.path() +
          "?pageSize=25" +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
      if (version !== this.version) return;
      trail[0] ??= page.startCursor;
      this.items.set(page.items);
      this.nextCursor.set(page.nextCursor);
      this.trail = trail;
      this.pageNumber.set(trail.length);
    } catch (e) {
      if (version === this.version) this.error.set(errorMessage(e));
    } finally {
      if (version === this.version) this.busy.set(false);
    }
  }
}

interface HistoryNavigation {
  busy: Signal<boolean>;
  error: Signal<string>;
  pageNumber: Signal<number>;
  nextCursor: Signal<string | null>;
  next(): Promise<void>;
  previous(): Promise<void>;
}

@Component({
  selector: "history-navigation",
  standalone: true,
  template: `
    @if (history().error()) {
      <div class="alert error mt-4" role="alert">{{ history().error() }}</div>
    }
    <nav
      class="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4"
      [attr.aria-label]="label() + ' pagination'"
    >
      <button
        class="text-button"
        [attr.aria-label]="'Newer ' + label()"
        [disabled]="
          disabled() || history().busy() || history().pageNumber() === 1
        "
        (click)="history().previous()"
      >
        ← Newer
      </button>
      <p class="muted text-xs" aria-live="polite" aria-atomic="true">
        Page {{ history().pageNumber() }} ·
        {{ history().busy() ? "Loading…" : "Up to 25 records" }}
      </p>
      <button
        class="text-button"
        [attr.aria-label]="'Older ' + label()"
        [disabled]="disabled() || history().busy() || !history().nextCursor()"
        (click)="history().next()"
      >
        Older →
      </button>
    </nav>
  `,
})
export class HistoryNavigationComponent {
  history = input.required<HistoryNavigation>();
  label = input.required<string>();
  disabled = input(false);
}
