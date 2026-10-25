/** Strict, side-effect-free validation for the public option-chain API. */

import {
  parseFieldGroups,
  parseStrikeRange,
  type FieldGroup,
  type StrikeRange,
} from "./chain-selection";

export type OutputFormat = "json" | "csv";

export interface OptionChainQuery {
  symbol: string;
  /** null means "newest snapshot for this symbol, any expiry". */
  expiry: string | null;
  format: OutputFormat;
  range: StrikeRange;
  fields: FieldGroup[];
}

export interface HistoryQuery {
  symbol: string;
  expiry: string;
  limit: number;
}

export type QueryValidation<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

export const MAX_HISTORY_LIMIT = 240;
export const DEFAULT_HISTORY_LIMIT = 60;

const SYMBOL_RE = /^[A-Za-z0-9&._-]{1,20}$/;
const EXPIRY_RE = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function titleCaseMonth(value: string): string {
  const lower = value.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function isValidCalendarDate(day: number, month: number, year: number): boolean {
  if (year < 2000 || year > 2100) return false;
  const probe = new Date(Date.UTC(year, month, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month &&
    probe.getUTCDate() === day
  );
}

/**
 * Canonical form used in the document (27-Oct-2026). If the caller sends a
 * lowercase month we normalise it; the day is kept as given and also queried
 * with a leading zero (see `expiryVariants`).
 */
export function canonicalExpiry(expiry: string): string | null {
  const match = expiry.trim().match(EXPIRY_RE);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS[match[2].toLowerCase()];
  const year = Number(match[3]);
  if (month === undefined || !isValidCalendarDate(day, month, year)) return null;
  return `${day}-${titleCaseMonth(match[2])}-${year}`;
}

/** NSE stores days zero-padded in some expiries; accept either spelling. */
export function expiryVariants(canonical: string): string[] {
  const match = canonical.match(EXPIRY_RE);
  if (!match) return [canonical];
  const day = Number(match[1]);
  const month = titleCaseMonth(match[2]);
  const year = match[3];
  return [...new Set([`${day}-${month}-${year}`, `${String(day).padStart(2, "0")}-${month}-${year}`])];
}

function fail(status: number, code: string, message: string) {
  return { ok: false as const, status, code, message };
}

function validateSymbol(raw: string) {
  const symbol = raw.trim();
  if (!symbol) {
    return fail(400, "missing_symbol", "symbol is required, e.g. ?symbol=NIFTY");
  }
  if (!SYMBOL_RE.test(symbol)) {
    return fail(400, "invalid_symbol", "symbol must be 1-20 characters: letters, digits, & . _ or -");
  }
  return { ok: true as const, value: symbol.toUpperCase() };
}

export function parseOptionChainQuery(
  searchParams: URLSearchParams,
): QueryValidation<OptionChainQuery> {
  const symbol = validateSymbol(searchParams.get("symbol") ?? "");
  if (!symbol.ok) return symbol;

  const rawExpiry = (searchParams.get("expiry") ?? "").trim();
  let expiry: string | null = null;
  if (rawExpiry) {
    expiry = canonicalExpiry(rawExpiry);
    if (!expiry) {
      return fail(400, "invalid_expiry", "expiry must be a real date in the form 27-Oct-2026");
    }
  }

  const rawFormat = (searchParams.get("format") ?? "json").trim().toLowerCase();
  if (rawFormat !== "json" && rawFormat !== "csv") {
    return fail(400, "invalid_format", "format must be one of: json, csv");
  }

  const range = parseStrikeRange(searchParams.get("range"));
  if (!range) {
    return fail(400, "invalid_range", "range must be one of: all, 10, 20, 30");
  }

  const fields = parseFieldGroups(searchParams.get("fields"));
  if (!fields) {
    return fail(
      400,
      "invalid_fields",
      "fields must be a comma-separated list of: oi, oi_change, volume, iv, ltp, price_change, bid_ask",
    );
  }

  return {
    ok: true,
    value: { symbol: symbol.value, expiry, format: rawFormat, range, fields },
  };
}

/** `GET /api/option-chain/expiries?symbol=NIFTY` */
export function parseSymbolQuery(
  searchParams: URLSearchParams,
): QueryValidation<{ symbol: string }> {
  const symbol = validateSymbol(searchParams.get("symbol") ?? "");
  if (!symbol.ok) return symbol;
  return { ok: true, value: { symbol: symbol.value } };
}

/** `GET /api/option-chain/history?symbol=NIFTY&expiry=27-Oct-2026&limit=60` */
export function parseHistoryQuery(
  searchParams: URLSearchParams,
): QueryValidation<HistoryQuery> {
  const symbol = validateSymbol(searchParams.get("symbol") ?? "");
  if (!symbol.ok) return symbol;

  const rawExpiry = (searchParams.get("expiry") ?? "").trim();
  if (!rawExpiry) {
    return fail(400, "missing_expiry", "expiry is required for history, e.g. 27-Oct-2026");
  }
  const expiry = canonicalExpiry(rawExpiry);
  if (!expiry) {
    return fail(400, "invalid_expiry", "expiry must be a real date in the form 27-Oct-2026");
  }

  const rawLimit = (searchParams.get("limit") ?? "").trim();
  let limit = DEFAULT_HISTORY_LIMIT;
  if (rawLimit) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_HISTORY_LIMIT) {
      return fail(400, "invalid_limit", `limit must be a whole number between 1 and ${MAX_HISTORY_LIMIT}`);
    }
    limit = parsed;
  }

  return { ok: true, value: { symbol: symbol.value, expiry, limit } };
}
