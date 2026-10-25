/**
 * Refresh coordination for the dashboard.
 *
 * Kept outside the React component so the concurrency rules are testable
 * without a browser: one read at a time, a newer request cancels the older one,
 * and a finished/failed request releases the guard so polling can continue.
 */

export interface RequestTicket {
  /** Symbol|expiry key this request belongs to. */
  key: string;
  signal: AbortSignal;
}

export class RefreshGuard {
  private controller: AbortController | null = null;
  private currentKey: string | null = null;

  /**
   * Start a request. Returns null when the same key is already in flight, so a
   * timer tick cannot duplicate an identical read. A different key aborts the
   * older request (for example when the user switches expiry).
   */
  begin(key: string): RequestTicket | null {
    if (this.currentKey === key) return null;

    this.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.currentKey = key;
    return { key, signal: controller.signal };
  }

  /**
   * Release the guard when a request settles. Older requests finishing after a
   * newer one took over are ignored, so they cannot unlock the new request.
   */
  finish(key: string): void {
    if (this.currentKey !== key) return;
    this.controller = null;
    this.currentKey = null;
  }

  /** Cancel whatever is in flight (unmount, manual abort). */
  abort(): void {
    const controller = this.controller;
    this.controller = null;
    this.currentKey = null;
    controller?.abort();
  }

  get inFlightKey(): string | null {
    return this.currentKey;
  }
}

/**
 * True when a tab that just became visible is overdue for a poll. `now` and
 * `lastRefreshAt` are epoch milliseconds; a never-refreshed tab is always due.
 */
export function shouldRefreshOnReturn(
  lastRefreshAt: number | null,
  intervalMs: number,
  now: number,
): boolean {
  if (lastRefreshAt === null) return true;
  return now - lastRefreshAt >= intervalMs;
}
