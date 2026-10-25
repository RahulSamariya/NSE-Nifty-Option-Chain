import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

export {
  getSnapshotFreshness,
  getSnapshotStatus,
  isIndianMarketOpen,
  parseNseTimestamp,
} from "./market-status";
export type { FreshnessReason, SnapshotFreshness, SnapshotStatus } from "./market-status";
export { isOptionChainRecord, normalizeOptionChainRecord } from "./option-chain-record";

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
