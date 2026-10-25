import { describe, expect, it } from "vitest";
import { RefreshGuard, shouldRefreshOnReturn } from "@/lib/refresh-guard";

describe("RefreshGuard", () => {
  it("ignores a second read for the same symbol/expiry instead of overlapping", () => {
    const guard = new RefreshGuard();
    const first = guard.begin("NIFTY|newest");
    expect(first).not.toBeNull();
    expect(first!.signal.aborted).toBe(false);

    const duplicate = guard.begin("NIFTY|newest");
    expect(duplicate).toBeNull();
    expect(first!.signal.aborted).toBe(false);
    expect(guard.inFlightKey).toBe("NIFTY|newest");
  });

  it("cancels the older read when the user switches expiry", () => {
    const guard = new RefreshGuard();
    const first = guard.begin("NIFTY|newest")!;
    const second = guard.begin("NIFTY|27-Oct-2026")!;

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(guard.inFlightKey).toBe("NIFTY|27-Oct-2026");
  });

  it("allows a retry after a finished or failed request", () => {
    const guard = new RefreshGuard();
    const first = guard.begin("NIFTY|newest")!;
    guard.finish(first.key); // finally block after an error behaves the same

    expect(guard.inFlightKey).toBeNull();
    const retry = guard.begin("NIFTY|newest");
    expect(retry).not.toBeNull();
    expect(retry!.signal).not.toBe(first.signal);
  });

  it("does not let a cancelled older request release the newer one", () => {
    const guard = new RefreshGuard();
    const first = guard.begin("NIFTY|newest")!;
    const second = guard.begin("BANKNIFTY|newest")!;
    guard.finish(first.key);

    expect(guard.inFlightKey).toBe("BANKNIFTY|newest");
    expect(guard.begin("BANKNIFTY|newest")).toBeNull();
    expect(second.signal.aborted).toBe(false);
  });

  it("aborts in-flight work on unmount and can start again", () => {
    const guard = new RefreshGuard();
    const ticket = guard.begin("NIFTY|newest")!;
    guard.abort();

    expect(ticket.signal.aborted).toBe(true);
    expect(guard.inFlightKey).toBeNull();
    expect(guard.begin("NIFTY|newest")).not.toBeNull();
  });

  it("treats an interval change as a new schedule, not a stuck guard", () => {
    const guard = new RefreshGuard();
    const first = guard.begin("NIFTY|newest")!;
    guard.finish(first.key);
    // A new 5-minute timer simply calls fetchData again; the guard is free.
    expect(guard.begin("NIFTY|newest")).not.toBeNull();
  });
});

describe("shouldRefreshOnReturn", () => {
  const minute = 60_000;
  const last = 1_000_000;

  it("refreshes a tab that never loaded data", () => {
    expect(shouldRefreshOnReturn(null, 1 * minute, last)).toBe(true);
  });

  it("refreshes only when the interval has fully elapsed", () => {
    expect(shouldRefreshOnReturn(last, 5 * minute, last + 5 * minute - 1)).toBe(false);
    expect(shouldRefreshOnReturn(last, 5 * minute, last + 5 * minute)).toBe(true);
    expect(shouldRefreshOnReturn(last, 5 * minute, last + 30 * minute)).toBe(true);
  });

  it("uses the currently selected interval, so changes take effect immediately", () => {
    const now = last + 6 * minute;
    expect(shouldRefreshOnReturn(last, 15 * minute, now)).toBe(false);
    expect(shouldRefreshOnReturn(last, 1 * minute, now)).toBe(true);
    expect(shouldRefreshOnReturn(last, 30 * minute, now)).toBe(false);
  });
});
