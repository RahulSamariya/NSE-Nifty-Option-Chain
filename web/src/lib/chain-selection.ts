/**
 * Strike-range and import-field selection.
 *
 * The dashboard, the JSON/CSV API and the Excel export all use these helpers so
 * a range picked in the browser means exactly the same window in the workbook,
 * and the field checkboxes select real columns rather than decorating labels.
 */
import { CHAIN_FIELDS, STRIKE_FIELD, type FieldSpec } from "./option-chain-fields";

export type StrikeRange = "all" | "10" | "20" | "30";

export interface StrikeRangeOption {
  value: StrikeRange;
  label: string;
  /** Number of strikes kept on each side of ATM; 0 means the whole chain. */
  radius: number;
}

export const STRIKE_RANGE_OPTIONS: StrikeRangeOption[] = [
  { value: "all", label: "All strikes", radius: 0 },
  { value: "10", label: "10 around ATM", radius: 10 },
  { value: "20", label: "20 around ATM", radius: 20 },
  { value: "30", label: "30 around ATM", radius: 30 },
];

export const DEFAULT_STRIKE_RANGE: StrikeRange = "all";

export function strikeRadius(range: StrikeRange): number {
  return STRIKE_RANGE_OPTIONS.find((option) => option.value === range)?.radius ?? 0;
}

export function rangeLabel(range: StrikeRange): string {
  if (range === "all") return "All strikes";
  const radius = strikeRadius(range);
  return `ATM +/- ${radius} strikes`;
}

/** Accepts the documented values, plus `0`/`0-...` aliases for "all". */
export function parseStrikeRange(value: string | null | undefined): StrikeRange | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw || raw === "all" || raw === "0") return "all";
  if (raw === "10" || raw === "20" || raw === "30") return raw;
  return null;
}

function nearestIndex<T extends { STRIKE: number }>(rows: T[], spot: number): number {
  if (rows.length === 0) return -1;
  let best = 0;
  let bestDiff = Math.abs(Number(rows[0].STRIKE) - spot);
  for (let index = 1; index < rows.length; index += 1) {
    const diff = Math.abs(Number(rows[index].STRIKE) - spot);
    if (diff < bestDiff) {
      best = index;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * Window of `2 * radius + 1` strikes around the strike closest to spot, clamped
 * at the ends of the chain. `radius === 0` returns everything.
 */
export function selectStrikes<T extends { STRIKE: number }>(
  rows: T[],
  spot: number,
  range: StrikeRange,
): T[] {
  const radius = strikeRadius(range);
  if (radius === 0 || rows.length === 0) return [...rows];

  const sorted = [...rows].sort((a, b) => Number(a.STRIKE) - Number(b.STRIKE));
  const atm = nearestIndex(sorted, spot);
  if (atm === -1) return sorted;

  const start = Math.max(0, atm - radius);
  const end = Math.min(sorted.length, atm + radius + 1);
  return sorted.slice(start, end);
}

export type FieldGroup =
  | "oi"
  | "oi_change"
  | "volume"
  | "iv"
  | "ltp"
  | "price_change"
  | "bid_ask";

export interface FieldGroupSpec {
  value: FieldGroup;
  label: string;
  /** Raw NSE suffix, applied to both CE_ and PE_. */
  keys: string[];
  /** Part of the default export; bid/ask is opt-in because it doubles columns. */
  required: boolean;
}

export const FIELD_GROUPS: FieldGroupSpec[] = [
  { value: "oi", label: "Open interest", keys: ["OI"], required: true },
  {
    value: "oi_change",
    label: "Change in OI",
    keys: ["CHNG_IN_OI", "PCHNG_IN_OI"],
    required: true,
  },
  { value: "volume", label: "Volume", keys: ["VOLUME"], required: true },
  { value: "iv", label: "IV", keys: ["IV"], required: true },
  { value: "ltp", label: "LTP", keys: ["LTP"], required: true },
  {
    value: "price_change",
    label: "Price change",
    keys: ["CHNG", "PCHNG"],
    required: true,
  },
  {
    value: "bid_ask",
    label: "Bid / Ask",
    keys: ["BID_QTY", "BID", "ASK", "ASK_QTY"],
    required: false,
  },
];

export const DEFAULT_FIELD_GROUPS: FieldGroup[] = FIELD_GROUPS.filter(
  (group) => group.required,
).map((group) => group.value);

export const ALL_FIELD_GROUPS: FieldGroup[] = FIELD_GROUPS.map((group) => group.value);

export function isFieldGroup(value: string): value is FieldGroup {
  return FIELD_GROUPS.some((group) => group.value === value);
}

/**
 * Parse `fields=oi,iv,...`. A missing parameter means "the complete chain"
 * (backward compatible for API clients); `all` is the same thing spelled out.
 * Returns null for unknown values.
 */
export function parseFieldGroups(
  raw: string | null | undefined,
): FieldGroup[] | null {
  const text = (raw ?? "").trim().toLowerCase();
  if (!text) return [...ALL_FIELD_GROUPS];
  if (text === "all") return [...ALL_FIELD_GROUPS];

  const parts = [...new Set(text.split(",").map((part) => part.trim()).filter(Boolean))];
  if (parts.length === 0) return [...ALL_FIELD_GROUPS];
  if (!parts.every(isFieldGroup)) return null;
  return parts as FieldGroup[];
}

/** Column schema for the selected groups: strike first, then CE, then PE. */
export function selectChainFields(groups: FieldGroup[]): FieldSpec[] {
  const selected = new Set<FieldGroup>(groups);
  const suffixes = new Set<string>();
  for (const group of FIELD_GROUPS) {
    if (!selected.has(group.value)) continue;
    for (const key of group.keys) suffixes.add(key);
  }

  return [STRIKE_FIELD].concat(
    CHAIN_FIELDS.filter(
      (field) => field.key !== "STRIKE" && suffixes.has(field.key.replace(/^(CE|PE)_/, "")),
    ),
  );
}

export function fieldGroupLabels(groups: FieldGroup[]): string {
  const labels = FIELD_GROUPS.filter((group) => groups.includes(group.value)).map(
    (group) => group.label,
  );
  return labels.length > 0 ? labels.join(", ") : "Summary only";
}

/** Copy a strike row, keeping only the requested columns. */
export function pickFields<T extends Record<string, unknown>>(
  row: T,
  fields: FieldSpec[],
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) picked[field.key] = row[field.key] ?? null;
  return picked;
}
