import { createClient } from "@supabase/supabase-js";
import { OptionChainRecord } from "@/types/option-chain";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

export type SnapshotStatus = "Live" | "Last Close" | "Stale" | "Unavailable";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

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

export function getSnapshotStatus(
  nseTimestamp: string | null | undefined,
  now = new Date(),
): SnapshotStatus {
  const sourceTime = parseNseTimestamp(nseTimestamp);
  if (!sourceTime) return "Unavailable";

  const sourceLocal = new Date(sourceTime.getTime() + 330 * 60 * 1000);
  const sourceMinute = sourceLocal.getUTCHours() * 60 + sourceLocal.getUTCMinutes();
  if (sourceMinute < 9 * 60 + 15 || sourceMinute > 15 * 60 + 35) return "Stale";

  const nowParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => nowParts.find((item) => item.type === type)?.value;
  const weekday = part("weekday");
  const nowMinute = Number(part("hour")) * 60 + Number(part("minute"));
  const isMarketOpen =
    ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday || "") &&
    nowMinute >= 9 * 60 + 15 && nowMinute <= 15 * 60 + 35;
  const sourceDate = `${sourceLocal.getUTCFullYear()}-${sourceLocal.getUTCMonth()}-${sourceLocal.getUTCDate()}`;
  const currentDate = `${part("year")}-${Number(part("month")) - 1}-${Number(part("day"))}`;
  const ageMs = now.getTime() - sourceTime.getTime();

  if (ageMs < -60_000) return "Stale";
  if (isMarketOpen) {
    return sourceDate === currentDate && ageMs <= 5 * 60_000 ? "Live" : "Stale";
  }
  return ageMs <= 72 * 60 * 60 * 1000 ? "Last Close" : "Stale";
}

export function isOptionChainRecord(
  value: unknown,
  symbol: string,
): value is OptionChainRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<OptionChainRecord>;
  return row.symbol === symbol && typeof row.expiry === "string" &&
    typeof row.spot === "number" && Number.isFinite(row.spot) && row.spot > 0 &&
    Array.isArray(row.raw_data) && row.raw_data.length > 0 &&
    row.raw_data.every((strike) =>
      Boolean(strike) && typeof strike === "object" && Number.isFinite(strike.STRIKE)
    );
}

// Indian number formatting helper: 1,05,611
export function formatIndian(val: number | string | null | undefined, decimals = 0): string {
  if (val === null || val === undefined) return "-";
  const num = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(num) || num === 0) return "-";

  const isNeg = num < 0;
  const absNum = Math.abs(num);
  const fixed = absNum.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");

  let formatted = intPart;
  if (intPart.length > 3) {
    const lastThree = intPart.substring(intPart.length - 3);
    const rest = intPart.substring(0, intPart.length - 3);
    formatted = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + lastThree;
  }

  const result = (isNeg ? "-" : "") + formatted + (decPart ? "." + decPart : "");
  return result;
}
