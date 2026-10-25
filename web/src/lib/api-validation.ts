/** Strict, side-effect-free validation for the public option-chain API. */

export type OutputFormat = "json" | "csv";

export interface OptionChainQuery {
  symbol: string;
  /** null means "newest snapshot for this symbol, any expiry". */
  expiry: string | null;
  format: OutputFormat;
}

export type QueryValidation =
  | { ok: true; value: OptionChainQuery }
  | { ok: false; status: number; code: string; message: string };

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

export function parseOptionChainQuery(searchParams: URLSearchParams): QueryValidation {
  const rawSymbol = (searchParams.get("symbol") ?? "").trim();
  if (!rawSymbol) {
    return {
      ok: false,
      status: 400,
      code: "missing_symbol",
      message: "symbol is required, e.g. ?symbol=NIFTY",
    };
  }
  if (!SYMBOL_RE.test(rawSymbol)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_symbol",
      message: "symbol must be 1-20 characters: letters, digits, & . _ or -",
    };
  }

  const rawExpiry = (searchParams.get("expiry") ?? "").trim();
  let expiry: string | null = null;
  if (rawExpiry) {
    expiry = canonicalExpiry(rawExpiry);
    if (!expiry) {
      return {
        ok: false,
        status: 400,
        code: "invalid_expiry",
        message: "expiry must be a real date in the form 27-Oct-2026",
      };
    }
  }

  const rawFormat = (searchParams.get("format") ?? "json").trim().toLowerCase();
  if (rawFormat !== "json" && rawFormat !== "csv") {
    return {
      ok: false,
      status: 400,
      code: "invalid_format",
      message: "format must be one of: json, csv",
    };
  }

  return {
    ok: true,
    value: { symbol: rawSymbol.toUpperCase(), expiry, format: rawFormat },
  };
}
