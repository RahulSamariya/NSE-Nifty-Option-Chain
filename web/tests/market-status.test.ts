import { describe, expect, it } from "vitest";
import {
  getSnapshotFreshness,
  getSnapshotStatus,
  isIndianMarketOpen,
  parseNseTimestamp,
} from "@/lib/market-status";

/** 2026-10-23 is a Friday, 2026-10-25 a Sunday, 2026-10-26 a Monday. */
const fridayCloseStamp = "23-Oct-2026 15:40:00";
const sundayNoonIst = new Date("2026-10-25T06:30:00Z"); // 12:00 IST
const mondayMorningIst = new Date("2026-10-26T04:30:00Z"); // 10:00 IST
const mondayJustAfterOpen = new Date("2026-10-26T04:35:00Z"); // 10:05 IST

describe("parseNseTimestamp", () => {
  it("reads the NSE string as IST, not as local time", () => {
    expect(parseNseTimestamp(fridayCloseStamp)?.toISOString()).toBe("2026-10-23T10:10:00.000Z");
  });

  it("rejects empty, malformed and impossible timestamps", () => {
    for (const value of ["", "   ", null, undefined, "23 Oct 2026 15:40", "32-Oct-2026 15:40:00", "23-Oct-2026 24:00:00"]) {
      expect(parseNseTimestamp(value)).toBeNull();
    }
  });
});

describe("isIndianMarketOpen", () => {
  it("is open only during the weekday session", () => {
    expect(isIndianMarketOpen(new Date("2026-10-26T03:45:00Z"))).toBe(true); // Mon 09:15 IST
    expect(isIndianMarketOpen(new Date("2026-10-26T03:44:00Z"))).toBe(false); // Mon 09:14 IST
    expect(isIndianMarketOpen(new Date("2026-10-26T10:00:00Z"))).toBe(true); // Mon 15:30 IST
    expect(isIndianMarketOpen(new Date("2026-10-26T10:01:00Z"))).toBe(false); // Mon 15:31 IST
    expect(isIndianMarketOpen(sundayNoonIst)).toBe(false);
  });

  it("is closed on verified 2026 exchange holidays", () => {
    // 2026-01-26 Republic Day (Monday at 11:00 IST)
    expect(isIndianMarketOpen(new Date("2026-01-26T05:30:00Z"))).toBe(false);
    // 2026-10-02 Mahatma Gandhi Jayanti (Friday at 11:00 IST)
    expect(isIndianMarketOpen(new Date("2026-10-02T05:30:00Z"))).toBe(false);
    // 2026-12-25 Christmas (Friday at 11:00 IST)
    expect(isIndianMarketOpen(new Date("2026-12-25T05:30:00Z"))).toBe(false);
  });

  it("handles special trading sessions like Diwali Muhurat trading", () => {
    // 2026-11-08 Sunday Diwali Muhurat Trading (18:00 - 19:15 IST = 12:30 - 13:45 UTC)
    const duringMuhurat = new Date("2026-11-08T13:00:00Z"); // 18:30 IST
    const beforeMuhurat = new Date("2026-11-08T12:20:00Z"); // 17:50 IST
    const afterMuhurat = new Date("2026-11-08T14:00:00Z"); // 19:30 IST
    const sundayMorning = new Date("2026-11-08T05:30:00Z"); // 11:00 IST

    expect(isIndianMarketOpen(duringMuhurat)).toBe(true);
    expect(isIndianMarketOpen(beforeMuhurat)).toBe(false);
    expect(isIndianMarketOpen(afterMuhurat)).toBe(false);
    expect(isIndianMarketOpen(sundayMorning)).toBe(false);
  });
});

describe("getSnapshotFreshness", () => {
  it("reports Friday's close on Sunday as Last Close, not Stale or Live", () => {
    const result = getSnapshotFreshness(fridayCloseStamp, sundayNoonIst);
    expect(result.status).toBe("Last Close");
    expect(result.marketOpen).toBe(false);
    expect(result.reason).toBe("ok");
  });

  it("reports the same snapshot as Live only when it is today and under 5 minutes old", () => {
    expect(getSnapshotStatus("26-Oct-2026 10:02:00", mondayJustAfterOpen)).toBe("Live");
  });

  it("reports today's data older than 5 minutes during a session as Stale", () => {
    const result = getSnapshotFreshness("26-Oct-2026 09:40:00", new Date("2026-10-26T06:00:00Z")); // 11:30 IST
    expect(result.status).toBe("Stale");
    expect(result.reason).toBe("market_open_stale");
  });

  it("reports a previous session's data during an open market as Stale", () => {
    expect(getSnapshotStatus(fridayCloseStamp, mondayMorningIst)).toBe("Stale");
  });

  it("reports Last Close data older than 96 hours as Stale", () => {
    const result = getSnapshotFreshness("01-Oct-2026 15:00:00", sundayNoonIst);
    expect(result.status).toBe("Stale");
    expect(result.reason).toBe("too_old");
  });

  it("never calls an out-of-session timestamp Live", () => {
    const result = getSnapshotFreshness("26-Oct-2026 08:30:00", mondayJustAfterOpen);
    expect(result.status).toBe("Stale");
    expect(result.reason).toBe("outside_session");
  });

  it("treats a future timestamp as Stale", () => {
    const result = getSnapshotFreshness("26-Oct-2026 12:00:00", mondayJustAfterOpen);
    expect(result.status).toBe("Stale");
    expect(result.reason).toBe("future_timestamp");
  });

  it("reports a missing timestamp as Unavailable", () => {
    expect(getSnapshotStatus(null, sundayNoonIst)).toBe("Unavailable");
    expect(getSnapshotFreshness("not-a-date", sundayNoonIst).ageSeconds).toBeNull();
  });
});
