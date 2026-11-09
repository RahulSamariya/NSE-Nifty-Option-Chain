import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatIst,
  healthTone,
  sessionLabel,
  sessionTone,
  symbolStatusTone,
  workerStateLabel,
  workerStateTone,
} from "@/lib/health-status";

describe("formatAge", () => {
  it("says never when nothing was written", () => {
    expect(formatAge(null)).toBe("never");
    expect(formatAge(undefined)).toBe("never");
    expect(formatAge(Number.NaN)).toBe("never");
  });

  it("formats seconds, minutes, hours and days", () => {
    expect(formatAge(0)).toBe("0s ago");
    expect(formatAge(45)).toBe("45s ago");
    expect(formatAge(59)).toBe("59s ago");
    expect(formatAge(60)).toBe("1m ago");
    expect(formatAge(3_599)).toBe("59m ago");
    expect(formatAge(3_600)).toBe("1h ago");
    expect(formatAge(3_660)).toBe("1h 1m ago");
    expect(formatAge(90_000)).toBe("1d ago");
  });

  it("clamps impossible negative ages instead of printing minus times", () => {
    expect(formatAge(-120)).toBe("0s ago");
  });
});

describe("formatIst", () => {
  it("renders an ISO instant as IST wall-clock text", () => {
    const label = formatIst("2026-11-09T10:09:55.445692+00:00");
    expect(label).toContain("15:39:55");
    expect(label).toContain("09 Nov 2026");
  });

  it("returns null for missing or unparseable input", () => {
    expect(formatIst(null)).toBeNull();
    expect(formatIst(undefined)).toBeNull();
    expect(formatIst("")).toBeNull();
    expect(formatIst("not-a-date")).toBeNull();
  });
});

describe("healthTone", () => {
  it("maps the pipeline verdict onto a badge tone", () => {
    expect(healthTone("ok")).toBe("good");
    expect(healthTone("degraded")).toBe("warn");
    expect(healthTone("unavailable")).toBe("bad");
    expect(healthTone("something-new")).toBe("bad");
  });
});

describe("symbolStatusTone", () => {
  it("keeps expected states calm and only warns on staleness", () => {
    expect(symbolStatusTone("Live")).toBe("good");
    expect(symbolStatusTone("Last Close")).toBe("info");
    expect(symbolStatusTone("Stale")).toBe("warn");
    expect(symbolStatusTone("Unavailable")).toBe("bad");
  });
});

describe("worker state labels", () => {
  it("translates every state the health route can emit", () => {
    expect(workerStateLabel("running")).toBe("Running");
    expect(workerStateLabel("delayed")).toBe("Delayed");
    expect(workerStateLabel("stalled")).toBe("Stalled");
    expect(workerStateLabel("idle_off_hours")).toBe("Idle (market closed)");
    expect(workerStateLabel("never")).toBe("No writes yet");
    expect(workerStateLabel("future-state")).toBe("future-state");
  });

  it("treats idle-off-hours as healthy, not as an alarm", () => {
    expect(workerStateTone("running")).toBe("good");
    expect(workerStateTone("idle_off_hours")).toBe("good");
    expect(workerStateTone("delayed")).toBe("warn");
    expect(workerStateTone("stalled")).toBe("bad");
    expect(workerStateTone("never")).toBe("bad");
  });
});

describe("sessionLabel", () => {
  it("names the open session plainly", () => {
    expect(sessionLabel(true, "open")).toBe("Open");
    // An open session never reports another reason, but if one slipped through
    // we would still show "Open" rather than a contradictory closed label.
    expect(sessionLabel(true, "weekend")).toBe("Open");
  });

  it("explains why the market is closed", () => {
    expect(sessionLabel(false, "weekend")).toBe("Closed — weekend");
    expect(sessionLabel(false, "exchange_holiday")).toBe("Closed — exchange holiday");
    expect(sessionLabel(false, "outside_trading_hours")).toBe(
      "Closed — outside trading hours",
    );
    expect(sessionLabel(false, "an-unknown-reason")).toBe("Closed");
  });

  it("only treats an open session as the good state", () => {
    expect(sessionTone(true)).toBe("good");
    expect(sessionTone(false)).toBe("info");
  });
});
