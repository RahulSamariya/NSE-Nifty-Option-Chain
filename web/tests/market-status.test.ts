import { describe, expect, it } from "vitest";
import {
  SPECIAL_SESSIONS_2026,
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

  it("keeps Sunday 8 Nov 2026 Muhurat F&O session open from 14:20 to 15:40 IST", () => {
    // Same window as SPECIAL_SESSIONS_2026 in core/nse_core.py (backend):
    // NSE's official Diwali Muhurat derivatives session, 14:20-15:40 IST on
    // Sunday 8 November 2026. The old 18:00-19:15 evening window is closed.
    const boundaries: ReadonlyArray<readonly [string, boolean]> = [
      ["2026-11-08T05:30:00Z", false], // Sun 11:00 IST - long before the session
      ["2026-11-08T08:49:00Z", false], // Sun 14:19 IST - one minute before open
      ["2026-11-08T08:50:00Z", true], //  Sun 14:20 IST - open
      ["2026-11-08T10:00:00Z", true], //  Sun 15:30 IST - equity close, F&O continues
      ["2026-11-08T10:05:00Z", true], //  Sun 15:35 IST - open
      ["2026-11-08T10:10:00Z", true], //  Sun 15:40 IST - open (inclusive)
      ["2026-11-08T10:11:00Z", false], // Sun 15:41 IST - one minute after close
      ["2026-11-08T13:00:00Z", false], // Sun 18:30 IST - old evening window closed
      ["2026-11-09T03:45:00Z", true], //  Mon 09:15 IST - normal session opens
      ["2026-11-09T10:06:00Z", false], // Mon 15:36 IST - normal session closed
    ];
    for (const [iso, expected] of boundaries) {
      expect(isIndianMarketOpen(new Date(iso)), `${iso} should be ${expected}`).toBe(expected);
    }
  });

  it("declares the same Muhurat window as the backend calendar", () => {
    expect(SPECIAL_SESSIONS_2026).toEqual([
      { date: "2026-11-08", openMinute: 14 * 60 + 20, closeMinute: 15 * 60 + 40 },
    ]);
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
