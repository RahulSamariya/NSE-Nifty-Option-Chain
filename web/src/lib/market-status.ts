/**
 * NSE snapshot freshness.
 *
 * Pure functions shared by the browser dashboard and the API routes, so a
 * snapshot gets exactly the same label in both places. All decisions are based
 * on the real NSE source timestamp and the IST market session - never on when
 * the row happened to be written or read.
 */

export type SnapshotStatus = "Live" | "Last Close" | "Stale" | "Unavailable";

export type FreshnessReason =
  | "ok"
  | "invalid_timestamp"
  | "future_timestamp"
  | "outside_session"
  | "market_open_stale"
  | "too_old";

export interface SnapshotFreshness {
  status: SnapshotStatus;
  sourceTime: Date | null;
  ageSeconds: number | null;
  marketOpen: boolean;
  reason: FreshnessReason;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// IST session. NSE closes at 15:30 and stamps the final snapshot at 15:40,
// so anything up to 15:45 is still a valid same-session snapshot.
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;
const SESSION_LAST_STAMP_MIN = 15 * 60 + 45;

const LIVE_WINDOW_MS = 5 * 60 * 1000;
const LAST_CLOSE_WINDOW_MS = 96 * 60 * 60 * 1000; // Fri close -> Tue morning
const FUTURE_TOLERANCE_MS = 60 * 1000;

/**
 * Parse NSE's exchange-local string ("23-Oct-2026 15:40:00") as a real Date.
 * NSE timestamps are IST (UTC+05:30) without an offset suffix.
 */
export function parseNseTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = value.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;

  const [, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
  const month = MONTHS[monthText.toLowerCase()];
  if (month === undefined) return null;
  const day = Number(dayText);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const localAsUtc = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(localAsUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month ||
      check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return new Date(localAsUtc - 330 * 60 * 1000);
}

interface IstParts {
  weekday: string;
  dateKey: string;
  minuteOfDay: number;
}

function istParts(date: Date): IstParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return {
    weekday: part("weekday"),
    dateKey: `${part("year")}-${part("month")}-${part("day")}`,
    minuteOfDay: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

export function isIndianMarketOpen(now = new Date()): boolean {
  const { weekday, minuteOfDay } = istParts(now);
  return (
    WEEKDAYS.includes(weekday) &&
    minuteOfDay >= SESSION_OPEN_MIN &&
    minuteOfDay <= SESSION_CLOSE_MIN
  );
}

/**
 * Live        - market is open and the snapshot is from today, <= 5 minutes old
 * Last Close  - market is closed and this is the last session's snapshot
 * Stale       - a session is open and this is not today's data, or the data is
 *               too old / has an impossible timestamp
 * Unavailable - no parseable NSE source timestamp
 */
export function getSnapshotFreshness(
  nseTimestamp: string | null | undefined,
  now = new Date(),
): SnapshotFreshness {
  const marketOpen = isIndianMarketOpen(now);
  const sourceTime = parseNseTimestamp(nseTimestamp);

  if (!sourceTime) {
    return {
      status: "Unavailable",
      sourceTime: null,
      ageSeconds: null,
      marketOpen,
      reason: "invalid_timestamp",
    };
  }

  const ageMs = now.getTime() - sourceTime.getTime();
  const ageSeconds = Math.round(ageMs / 1000);
  const base = { sourceTime, ageSeconds, marketOpen };

  if (ageMs < -FUTURE_TOLERANCE_MS) {
    return { ...base, status: "Stale", reason: "future_timestamp" };
  }

  const nowIst = istParts(now);
  const srcIst = istParts(sourceTime);
  const sourceInSession =
    WEEKDAYS.includes(srcIst.weekday) &&
    srcIst.minuteOfDay >= SESSION_OPEN_MIN &&
    srcIst.minuteOfDay <= SESSION_LAST_STAMP_MIN;

  if (!sourceInSession) {
    return { ...base, status: "Stale", reason: "outside_session" };
  }

  if (marketOpen) {
    const isToday = srcIst.dateKey === nowIst.dateKey;
    const isLive = isToday && ageMs <= LIVE_WINDOW_MS;
    return {
      ...base,
      status: isLive ? "Live" : "Stale",
      reason: isLive ? "ok" : "market_open_stale",
    };
  }

  if (ageMs <= LAST_CLOSE_WINDOW_MS) {
    return { ...base, status: "Last Close", reason: "ok" };
  }
  return { ...base, status: "Stale", reason: "too_old" };
}

export function getSnapshotStatus(
  nseTimestamp: string | null | undefined,
  now = new Date(),
): SnapshotStatus {
  return getSnapshotFreshness(nseTimestamp, now).status;
}
