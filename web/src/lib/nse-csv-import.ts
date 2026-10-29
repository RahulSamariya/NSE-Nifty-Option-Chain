/**
 * NSE option-chain CSV import, parsed entirely in the browser.
 *
 * The file never leaves the machine: the dashboard reads the bytes the user
 * picked, maps columns through normalized headers (never fixed positions),
 * validates the contract, and only then replaces the displayed snapshot.
 *
 * Supported layouts (all seen in real NSE exports):
 *   1. Grouped header — a "CALLS ... PUTS" marker row above a field-name row,
 *      the classic NSE table with calls left of the strike and puts right.
 *   2. Flat duplicated headers — one row of field names repeated on both sides
 *      of a "Strike Price" column; left of strike is CALLS, right is PUTS.
 *   3. Prefixed headers — "CE OI", "PE_LTP", "Calls Volume", "Put IV", ...
 *
 * Metadata rows above the table (Symbol, Expiry Date, Last updated at,
 * Underlying Value) are read when present. An exchange timestamp is only ever
 * taken from the file; when it is missing the import time is recorded
 * separately and the snapshot reports no source timestamp.
 */
import type { OptionChainRecord, StrikeRow } from "@/types/option-chain";
import { normalizeOptionChainRecord } from "./option-chain-record";
import { summarizeChain } from "./chain-analytics";

export const SUPPORTED_SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY"] as const;

export interface CsvImportMeta {
  symbol: string;
  expiry: string;
  spot: number;
  /** "29-Oct-2026 15:30:00" when the file carried one, otherwise null. */
  exchangeTimestamp: string | null;
  /** Local time the file was parsed; never presented as an exchange time. */
  importedAt: string;
  fileName: string;
  fileSize: number;
  rowCount: number;
  /** Non-fatal notes: skipped columns, de-duplicated rows, etc. */
  warnings: string[];
}

export type CsvImportResult =
  | { ok: true; record: OptionChainRecord; meta: CsvImportMeta }
  | { ok: false; error: string };

export interface CsvImportOptions {
  fileName: string;
  fileSize: number;
  /** Injected for deterministic tests; defaults to now. */
  now?: Date;
}

// ---------------------------------------------------------------- tokenizer

/** RFC4180-ish row splitter: quoted fields, doubled quotes, any line ending.
 * A quote only opens a quoted field at the very start of that field; anywhere
 * else it is literal text, which is how Excel and NSE both emit CSV. */
export function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let atFieldStart = true;

  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    atFieldStart = true;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (atFieldStart && field === "") {
        inQuotes = true;
        atFieldStart = false;
      } else {
        field += char;
        atFieldStart = false;
      }
    } else if (char === ",") {
      row.push(field);
      field = "";
      atFieldStart = true;
    } else if (char === "\n" || char === "\r") {
      // Handles LF, CRLF and the legacy lone-CR Mac ending.
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
    } else {
      field += char;
      atFieldStart = false;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------- header names

/** Lower-case and strip every non-alphanumeric so "Chng in OI" == "chnginoi".
 * A percent sign is kept as the word "percent" so "Chng in OI %" does not
 * collapse onto the plain change-in-OI column. */
export function normalizeHeader(value: string): string {
  return value
    .replace(/[\u00a0\u2009\u202f]/g, " ")
    .toLowerCase()
    .replace(/%/g, " percent ")
    .replace(/[^a-z0-9]/g, "");
}

type FieldKey =
  | "OI"
  | "CHNG_IN_OI"
  | "PCHNG_IN_OI"
  | "VOLUME"
  | "IV"
  | "LTP"
  | "CHNG"
  | "PCHNG"
  | "BID"
  | "BID_QTY"
  | "ASK"
  | "ASK_QTY";

/** Normalized header -> canonical field. Order matters: first match wins. */
const FIELD_ALIASES: Record<string, FieldKey> = {
  oi: "OI",
  openinterest: "OI",
  chnginoi: "CHNG_IN_OI",
  changeinoi: "CHNG_IN_OI",
  changeinopeninterest: "CHNG_IN_OI",
  chnginopeninterest: "CHNG_IN_OI",
  pchnginoi: "PCHNG_IN_OI",
  pchangeinoi: "PCHNG_IN_OI",
  pchangeinopeninterest: "PCHNG_IN_OI",
  chnginoipercent: "PCHNG_IN_OI",
  changeinopeninterestpercent: "PCHNG_IN_OI",
  volume: "VOLUME",
  totaltradedvolume: "VOLUME",
  tradedvolume: "VOLUME",
  vol: "VOLUME",
  iv: "IV",
  impliedvolatility: "IV",
  ltp: "LTP",
  lastprice: "LTP",
  lasttradedprice: "LTP",
  chng: "CHNG",
  change: "CHNG",
  pricechange: "CHNG",
  chngpercent: "PCHNG",
  changepercent: "PCHNG",
  pchng: "PCHNG",
  pchange: "PCHNG",
  pricechangepercent: "PCHNG",
  bid: "BID",
  bidprice: "BID",
  bestbid: "BID",
  bidqty: "BID_QTY",
  bidquantity: "BID_QTY",
  bidqnty: "BID_QTY",
  ask: "ASK",
  askprice: "ASK",
  bestask: "ASK",
  offer: "ASK",
  offerprice: "ASK",
  askqty: "ASK_QTY",
  askquantity: "ASK_QTY",
  offerqty: "ASK_QTY",
  offerquantity: "ASK_QTY",
};

const STRIKE_HEADERS = new Set([
  "strike",
  "strikeprice",
  "strikepriceindiannumerals",
  "strikerate",
]);

const CALL_MARKERS = new Set(["calls", "call", "ce", "calloptions", "calloption"]);
const PUT_MARKERS = new Set(["puts", "put", "pe", "putoptions", "putoption"]);

// Longest alternatives first so "Calls Volume" matches "calls", not "call".
const SIDE_PREFIX_RE = /^(ce|pe|calls|call|puts|put)/;
const SIDE_SUFFIX_RE = /(ce|pe|calls|call|puts|put)$/;

/** Strip a CE/PE/call/put marker from either end of a normalized header. */
function stripSideMarker(normalized: string): { side: "CE" | "PE"; rest: string } | null {
  const prefix = normalized.match(SIDE_PREFIX_RE);
  if (prefix) {
    const rest = normalized.slice(prefix[0].length);
    if (FIELD_ALIASES[rest]) {
      return { side: prefix[0].startsWith("p") ? "PE" : "CE", rest };
    }
  }
  const suffix = normalized.match(SIDE_SUFFIX_RE);
  if (suffix) {
    const rest = normalized.slice(0, normalized.length - suffix[0].length);
    if (FIELD_ALIASES[rest]) {
      return { side: suffix[0].startsWith("p") ? "PE" : "CE", rest };
    }
  }
  return null;
}

// ------------------------------------------------------------ value parsing

const MISSING_MARKERS = new Set([
  "",
  "-",
  "--",
  "—",
  "na",
  "n/a",
  "nil",
  "none",
  "null",
  ".",
]);

/**
 * Parse an Indian-formatted number: "1,23,456.78" -> 123456.78, "(80)" -> -80.
 * Missing-value markers ("-") and blanks return null rather than 0, so the
 * dashboard can tell "no data" from "zero".
 */
export function parseIndianNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;

  let text = raw.replace(/[\u00a0\u2009\u202f]/g, " ").trim();
  if (MISSING_MARKERS.has(text.toLowerCase())) return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  // Currency symbols, thousands separators and stray spaces.
  text = text.replace(/[₹,\s]/g, "");
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return null;

  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

// ---------------------------------------------------------------- metadata

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const SYMBOL_LABELS = new Set([
  "symbol",
  "underlying",
  "underlyingsymbol",
  "underlyingindex",
  "underlyinginstrument",
  "index",
  "instrument",
  "security",
  "stock",
]);

export const SPOT_LABELS = new Set([
  "underlyingvalue",
  "underlyingprice",
  "spot",
  "spotprice",
  "indexvalue",
  "indexspot",
  "lasttradedpriceofunderlying",
  "currentprice",
  "cmp",
]);

export const EXPIRY_LABELS = new Set([
  "expiry",
  "expirydate",
  "expiration",
  "expirationdate",
  "expirytimeremaining",
  "expdate",
  "contractexpiry",
]);

export const TIMESTAMP_LABELS = new Set([
  "lastupdatedat",
  "lastupdated",
  "timestamp",
  "datetime",
  "updatetime",
  "lastupdatetime",
  "asof",
  "snapshottime",
  "time",
  "date",
  "nsetimestamp",
  "exchangetimestamp",
  "snapshotupdatedat",
  "sourcetimestamp",
]);

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Canonical "29-Oct-2026" from the date shapes NSE and Excel emit. */
export function canonicalExpiryFromCsv(value: string): string | null {
  const text = value.trim();
  let match = text.match(/^(\d{1,2})[-/ _]([A-Za-z]{3})[a-z]*[-/ _](\d{2,4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = MONTHS[match[2].toLowerCase()];
    if (month === undefined || day < 1 || day > DAYS_IN_MONTH[month]) return null;
    const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    return `${String(day).padStart(2, "0")}-${MONTH_NAMES[month]}-${year}`;
  }
  match = text.match(/^(\d{1,2})[-/_](\d{1,2})[-/_](\d{4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const year = Number(match[3]);
    if (month < 0 || month > 11 || day < 1 || day > DAYS_IN_MONTH[month]) return null;
    return `${String(day).padStart(2, "0")}-${MONTH_NAMES[month]}-${year}`;
  }
  match = text.match(/^(\d{4})[-/_](\d{1,2})[-/_](\d{1,2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    if (month < 0 || month > 11 || day < 1 || day > DAYS_IN_MONTH[month]) return null;
    return `${String(day).padStart(2, "0")}-${MONTH_NAMES[month]}-${year}`;
  }
  return null;
}

/** NSE's "29-Oct-2026 15:30:00" when the file carries one; else null. */
export function canonicalTimestampFromCsv(value: string): string | null {
  const text = value.replace(/\s*(?:IST|UTC|GMT)\s*$/i, "").trim();
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2}$/.test(text)) {
    const [datePart, timePart] = text.split(/\s+/);
    const expiry = canonicalExpiryFromCsv(datePart);
    return expiry ? `${expiry} ${timePart}` : null;
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (iso) {
    const expiry = canonicalExpiryFromCsv(`${iso[1]}-${iso[2]}-${iso[3]}`);
    return expiry ? `${expiry} ${iso[4]}:${iso[5]}:${iso[6] ?? "00"}` : null;
  }
  return null;
}

/** Map any detected symbol spelling onto the three the dashboard serves. */
export function canonicalSymbol(value: string): string | null {
  const compact = normalizeHeader(value);
  if (!compact) return null;
  if (compact === "nifty" || compact === "nifty50" || compact === "nifty50index") return "NIFTY";
  if (compact === "banknifty" || compact === "bankniftyindex") return "BANKNIFTY";
  if (compact === "finnifty" || compact === "finniftyindex") return "FINNIFTY";
  return null;
}

/** True when the text names a symbol the dashboard simply does not serve. */
export function looksLikeSymbol(value: string): boolean {
  const compact = normalizeHeader(value);
  return /^[a-z]{2,}nifty[a-z0-9]*$/.test(compact) || compact === "sensex" || compact === "bankex";
}

/**
 * Infer the canonical symbol from the file name when omitted from the file body.
 */
export function inferSymbolFromFileName(fileName: string): string | null {
  const clean = fileName.replace(/[^A-Za-z0-9]+/g, " ").toLowerCase();
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (
    tokens.some((t) => t === "banknifty" || t === "bankniftyindex") ||
    clean.includes("bank nifty")
  ) {
    return "BANKNIFTY";
  }
  if (
    tokens.some((t) => t === "finnifty" || t === "finniftyindex") ||
    clean.includes("fin nifty")
  ) {
    return "FINNIFTY";
  }
  if (tokens.some((t) => t === "nifty" || t === "nifty50" || t === "nifty50index")) {
    return "NIFTY";
  }
  return null;
}

/**
 * Infer the canonical expiry date from the file name when omitted from the file body.
 */
export function inferExpiryFromFileName(fileName: string): string | null {
  // Pattern 1: 29-Oct-2026, 29_Oct_2026, 29Oct2026
  const alphaMatch = fileName.match(/(\d{1,2})[-_ ]?([A-Za-z]{3})[a-z]*[-_ ]?(\d{2,4})/i);
  if (alphaMatch) {
    const exp = canonicalExpiryFromCsv(`${alphaMatch[1]}-${alphaMatch[2]}-${alphaMatch[3]}`);
    if (exp) return exp;
  }
  // Pattern 2: 2026-10-29, 2026_10_29
  const isoMatch = fileName.match(/(\d{4})[-_](\d{1,2})[-_](\d{1,2})/);
  if (isoMatch) {
    const exp = canonicalExpiryFromCsv(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`);
    if (exp) return exp;
  }
  // Pattern 3: 29-10-2026, 29_10_2026
  const dmyMatch = fileName.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{4})/);
  if (dmyMatch) {
    const exp = canonicalExpiryFromCsv(`${dmyMatch[1]}-${dmyMatch[2]}-${dmyMatch[3]}`);
    if (exp) return exp;
  }
  return null;
}

export interface ExtractedMetadata {
  symbol: string | null;
  rawSymbol: string | null;
  expiry: string | null;
  spot: number | null;
  exchangeTimestamp: string | null;
}

/**
 * Extract contract metadata from preamble rows above the table header.
 * Supports single key/value pairs, spacer columns, multi-pair rows, and colon-separated cells.
 */
export function extractPreambleMetadata(preambleRows: string[][]): ExtractedMetadata {
  let symbol: string | null = null;
  let rawSymbol: string | null = null;
  let expiry: string | null = null;
  let spot: number | null = null;
  let exchangeTimestamp: string | null = null;

  for (const row of preambleRows) {
    for (let j = 0; j < row.length; j += 1) {
      const rawCell = row[j] ?? "";
      const cell = rawCell.trim();
      if (!cell) continue;

      // 1. Colon or equals separated key: value in a single cell, e.g. "Symbol: NIFTY"
      const sepMatch = cell.match(/^([^:=]+)[:=]\s*(.*)$/);
      if (sepMatch) {
        const label = normalizeHeader(sepMatch[1]);
        const val = sepMatch[2].trim();

        if (val) {
          if (SYMBOL_LABELS.has(label)) {
            rawSymbol = rawSymbol ?? val;
            symbol = canonicalSymbol(val) ?? symbol;
            // Also inspect val for an embedded spot (e.g. "NIFTY 24,500.00")
            if (spot === null) {
              for (const token of val.split(/\s+/)) {
                const sp = parseIndianNumber(token);
                if (sp !== null && sp > 0) {
                  spot = sp;
                  break;
                }
              }
            }
            continue;
          }
          if (SPOT_LABELS.has(label)) {
            let candidateNumber = val;
            let nextK = j + 1;
            while (nextK < row.length && /^\d+(\.\d+)?$/.test(row[nextK].trim())) {
              candidateNumber += `,${row[nextK].trim()}`;
              nextK += 1;
            }
            const sp = parseIndianNumber(candidateNumber);
            if (sp !== null && sp > 0) {
              spot = sp;
              j = nextK - 1;
              continue;
            }
          }
          if (EXPIRY_LABELS.has(label)) {
            const exp = canonicalExpiryFromCsv(val);
            if (exp) expiry = exp;
            continue;
          }
          if (TIMESTAMP_LABELS.has(label)) {
            const ts = canonicalTimestampFromCsv(val);
            if (ts) exchangeTimestamp = ts;
            continue;
          }
        }
      }

      // 2. Cell is a recognized label (handles multiple pairs per row and spacer columns)
      const label = normalizeHeader(cell);
      if (
        SYMBOL_LABELS.has(label) ||
        SPOT_LABELS.has(label) ||
        EXPIRY_LABELS.has(label) ||
        TIMESTAMP_LABELS.has(label)
      ) {
        let val = "";
        let valIdx = -1;
        for (let k = j + 1; k < row.length; k += 1) {
          if ((row[k] ?? "").trim()) {
            val = (row[k] ?? "").trim();
            valIdx = k;
            break;
          }
        }
        if (val) {
          if (SYMBOL_LABELS.has(label)) {
            rawSymbol = rawSymbol ?? val;
            symbol = canonicalSymbol(val) ?? symbol;
            j = valIdx;
            continue;
          }
          if (SPOT_LABELS.has(label)) {
            let candidateNumber = val;
            let nextK = valIdx + 1;
            while (nextK < row.length && /^\d+(\.\d+)?$/.test(row[nextK].trim())) {
              candidateNumber += `,${row[nextK].trim()}`;
              nextK += 1;
            }
            const sp = parseIndianNumber(candidateNumber);
            if (sp !== null && sp > 0) {
              spot = sp;
              j = nextK - 1;
              continue;
            }
          }
          if (EXPIRY_LABELS.has(label)) {
            const exp = canonicalExpiryFromCsv(val);
            if (exp) expiry = exp;
            j = valIdx;
            continue;
          }
          if (TIMESTAMP_LABELS.has(label)) {
            const ts = canonicalTimestampFromCsv(val);
            if (ts) exchangeTimestamp = ts;
            j = valIdx;
            continue;
          }
        }
      }

      // 3. Standalone values without explicit labels
      if (!symbol) {
        const guess = canonicalSymbol(cell);
        if (guess) {
          rawSymbol = rawSymbol ?? cell;
          symbol = guess;
          continue;
        }
      }
      if (!expiry) {
        const guessExp = canonicalExpiryFromCsv(cell);
        if (guessExp) {
          expiry = guessExp;
          continue;
        }
      }
      if (!exchangeTimestamp) {
        const guessTs = canonicalTimestampFromCsv(cell);
        if (guessTs) {
          exchangeTimestamp = guessTs;
          continue;
        }
      }
    }
  }

  return { symbol, rawSymbol, expiry, spot, exchangeTimestamp };
}

// ------------------------------------------------------------------ parser

interface ColumnMap {
  strikeIndex: number;
  /** Canonical field -> column index, per side. */
  ce: Partial<Record<FieldKey, number>>;
  pe: Partial<Record<FieldKey, number>>;
  warnings: string[];
}

function isMarkerCell(value: string): { side: "CE" | "PE" } | null {
  const normalized = normalizeHeader(value);
  if (CALL_MARKERS.has(normalized)) return { side: "CE" };
  if (PUT_MARKERS.has(normalized)) return { side: "PE" };
  return null;
}

function buildColumnMap(
  headerCells: string[],
  groupCells: string[] | null,
  layoutName: string,
): ColumnMap | { error: string } {
  const warnings: string[] = [];
  const normalized = headerCells.map(normalizeHeader);

  const strikeIndex = normalized.findIndex((cell) => STRIKE_HEADERS.has(cell));
  if (strikeIndex === -1) {
    return {
      error:
        "No Strike Price column was found. Export the option chain table itself — " +
        "the file needs a header row containing 'Strike Price'.",
    };
  }

  const ce: Partial<Record<FieldKey, number>> = {};
  const pe: Partial<Record<FieldKey, number>> = {};

  // Grouped layout: "CALLS" and "PUTS" markers bound each side's columns.
  let callsStart: number | null = null;
  let putsStart: number | null = null;
  if (groupCells) {
    groupCells.forEach((cell, index) => {
      const marker = isMarkerCell(cell);
      if (!marker) return;
      if (marker.side === "CE" && callsStart === null) callsStart = index;
      if (marker.side === "PE" && putsStart === null) putsStart = index;
    });
  }

  const assign = (
    side: "CE" | "PE",
    index: number,
    field: FieldKey,
  ) => {
    const target = side === "CE" ? ce : pe;
    if (target[field] !== undefined) {
      warnings.push(
        `Column ${index + 1} ("${headerCells[index]}") repeats the ${side} ${field} column; the first one was kept.`,
      );
      return;
    }
    target[field] = index;
  };

  // Grouped layout: the "PUTS" marker (or the strike column) is the divider
  // between the call side and the put side. The CALLS marker is only a fallback
  // divider when no PUTS marker exists, and is never used as a hard left bound
  // so a leading call column above which "CALLS" is not printed is still read.
  let mapped = 0;
  normalized.forEach((cell, index) => {
    if (index === strikeIndex || !cell) return;

    // 1. Explicit CE/PE marker in the header itself wins over everything.
    const sided = stripSideMarker(cell);
    if (sided) {
      assign(sided.side, index, FIELD_ALIASES[sided.rest]);
      mapped += 1;
      return;
    }

    const field = FIELD_ALIASES[cell];
    if (!field) return; // an unrelated column; ignored rather than guessed

    // 2. Grouped layout with a PUTS divider: everything left of it is the call
    //    side, everything right is the put side, regardless of strike position.
    if (putsStart !== null) {
      assign(index < putsStart ? "CE" : "PE", index, field);
      mapped += 1;
      return;
    }

    // 3. Only a CALLS marker: its span is callsStart..strike, the rest is puts.
    if (callsStart !== null) {
      assign(index >= callsStart && index < strikeIndex ? "CE" : "PE", index, field);
      mapped += 1;
      return;
    }

    // 4. Flat layout: calls sit left of the strike, puts right of it.
    assign(index < strikeIndex ? "CE" : "PE", index, field);
    mapped += 1;
  });

  if (mapped === 0) {
    return {
      error:
        "The file has a Strike Price column but no recognised OI, LTP, IV, volume or bid/ask columns. " +
        "Re-download the option chain table from the NSE option chain page.",
    };
  }
  if (Object.keys(ce).length === 0 && Object.keys(pe).length === 0) {
    return {
      error:
        "No CALLS or PUTS columns could be matched. The file must contain the option chain " +
        "table with OI, LTP or similar columns for calls, puts, or both.",
    };
  }

  warnings.push(`Detected ${layoutName} column layout.`);
  return { strikeIndex, ce, pe, warnings };
}

/**
 * Parse a downloaded NSE option-chain CSV into a validated snapshot.
 * Returns a plain-language error instead of a record for anything that is not
 * a genuine, internally consistent chain.
 */
export function parseNseOptionChainCsv(
  text: string,
  options: CsvImportOptions,
): CsvImportResult {
  const now = options.now ?? new Date();
  const body = text.replace(/^\uFEFF/, "");

  if (!body.trim()) {
    return { ok: false, error: "This file is empty." };
  }

  const allRows = splitCsvRows(body);
  const trimmed = allRows
    .map((row) => row.map((cell) => cell.trim()))
    .filter((row) => row.some((cell) => cell !== ""));

  if (trimmed.length === 0) {
    return { ok: false, error: "This file contains no readable rows." };
  }

  // Locate the header row: the one holding the strike column.
  let headerIndex = -1;
  let groupCells: string[] | null = null;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i].some((cell) => STRIKE_HEADERS.has(normalizeHeader(cell)))) {
      headerIndex = i;
      const previous = i > 0 ? trimmed[i - 1] : null;
      if (previous && previous.some((cell) => isMarkerCell(cell))) {
        groupCells = previous;
      }
      break;
    }
  }

  if (headerIndex === -1) {
    return {
      ok: false,
      error:
        "No option-chain table was found in this file. Download the CSV from the NSE " +
        "option chain page — the export must include a 'Strike Price' column.",
    };
  }

  const hasGroupRow = groupCells !== null;
  const map = buildColumnMap(
    trimmed[headerIndex],
    groupCells,
    hasGroupRow ? "grouped CALLS/PUTS" : "flat",
  );
  if ("error" in map) return { ok: false, error: map.error };
  const warnings = map.warnings;

  // ---- 1. metadata from the rows above the table -----------------------
  const preambleRows = trimmed.slice(0, headerIndex - (hasGroupRow ? 1 : 0));
  let { symbol, rawSymbol, expiry, spot, exchangeTimestamp } =
    extractPreambleMetadata(preambleRows);

  // ---- 2. metadata from table columns (round-trip dashboard export) -----
  const headerCells = trimmed[headerIndex];
  const headerNormalized = headerCells.map(normalizeHeader);
  const metaColSymbol = headerNormalized.findIndex((c) => SYMBOL_LABELS.has(c));
  const metaColExpiry = headerNormalized.findIndex((c) => EXPIRY_LABELS.has(c));
  const metaColSpot = headerNormalized.findIndex((c) => SPOT_LABELS.has(c));
  const metaColTimestamp = headerNormalized.findIndex((c) => TIMESTAMP_LABELS.has(c));

  let extractedFromColumns = false;
  if (
    (!symbol || !expiry || spot === null || !exchangeTimestamp) &&
    (metaColSymbol !== -1 || metaColExpiry !== -1 || metaColSpot !== -1 || metaColTimestamp !== -1)
  ) {
    for (let i = headerIndex + 1; i < trimmed.length; i += 1) {
      const cells = trimmed[i];
      if (cells.length <= map.strikeIndex) continue;
      const strike = parseIndianNumber(cells[map.strikeIndex]);
      if (strike === null || strike <= 0) continue;

      if (!symbol && metaColSymbol !== -1 && cells[metaColSymbol]) {
        const val = cells[metaColSymbol].trim();
        rawSymbol = rawSymbol ?? val;
        symbol = canonicalSymbol(val) ?? symbol;
        extractedFromColumns = true;
      }
      if (!expiry && metaColExpiry !== -1 && cells[metaColExpiry]) {
        const exp = canonicalExpiryFromCsv(cells[metaColExpiry]);
        if (exp) {
          expiry = exp;
          extractedFromColumns = true;
        }
      }
      if (spot === null && metaColSpot !== -1 && cells[metaColSpot]) {
        const sp = parseIndianNumber(cells[metaColSpot]);
        if (sp !== null && sp > 0) {
          spot = sp;
          extractedFromColumns = true;
        }
      }
      if (!exchangeTimestamp && metaColTimestamp !== -1 && cells[metaColTimestamp]) {
        const ts = canonicalTimestampFromCsv(cells[metaColTimestamp]);
        if (ts) {
          exchangeTimestamp = ts;
          extractedFromColumns = true;
        }
      }
      if (symbol && expiry && spot !== null) break;
    }
  }
  if (extractedFromColumns) {
    warnings.push("Extracted metadata (symbol, expiry, or spot) from table columns.");
  }

  // ---- 3. file name fallback -------------------------------------------
  if (!symbol && options.fileName) {
    const inferred = inferSymbolFromFileName(options.fileName);
    if (inferred) {
      symbol = inferred;
      rawSymbol = rawSymbol ?? inferred;
      warnings.push(`Inferred symbol "${symbol}" from file name "${options.fileName}".`);
    } else {
      const clean = options.fileName.replace(/[^A-Za-z0-9]+/g, " ").toLowerCase();
      const tokens = clean.split(/\s+/).filter(Boolean);
      const other = tokens.find((t) => looksLikeSymbol(t));
      if (other) rawSymbol = rawSymbol ?? other;
    }
  }
  if (!expiry && options.fileName) {
    const inferredExp = inferExpiryFromFileName(options.fileName);
    if (inferredExp) {
      expiry = inferredExp;
      warnings.push(`Inferred expiry date "${expiry}" from file name "${options.fileName}".`);
    }
  }

  // ---- data rows --------------------------------------------------------
  const rows: StrikeRow[] = [];
  const byStrike = new Map<number, StrikeRow>();
  let conflictingStrike: string | null = null;
  let skipped = 0;

  for (let i = headerIndex + 1; i < trimmed.length; i += 1) {
    const cells = trimmed[i];
    if (metaColExpiry !== -1 && expiry && cells[metaColExpiry]) {
      const rowExp = canonicalExpiryFromCsv(cells[metaColExpiry]);
      if (rowExp && rowExp !== expiry) {
        skipped += 1;
        continue;
      }
    }
    const strike = parseIndianNumber(cells[map.strikeIndex]);
    if (strike === null || strike <= 0) {
      skipped += 1;
      continue;
    }

    const row: StrikeRow = { STRIKE: strike };
    let touched = false;
    (["CE", "PE"] as const).forEach((side) => {
      const columns = side === "CE" ? map.ce : map.pe;
      for (const [field, columnIndex] of Object.entries(columns)) {
        const value = parseIndianNumber(cells[columnIndex as number]);
        if (value !== null) {
          row[`${side}_${field}`] = value;
          touched = true;
        }
      }
    });
    if (!touched) {
      // A strike with no call and no put data is not a usable chain row.
      skipped += 1;
      continue;
    }

    const existing = byStrike.get(strike);
    if (existing) {
      if (JSON.stringify(existing) === JSON.stringify(row)) {
        warnings.push(`Strike ${strike} appeared twice with identical values; the duplicate was ignored.`);
        continue;
      }
      conflictingStrike = String(strike);
      break;
    }
    byStrike.set(strike, row);
    rows.push(row);
  }

  if (conflictingStrike) {
    return {
      ok: false,
      error:
        `Strike ${conflictingStrike} appears twice with different values, so the file cannot ` +
        "be trusted as one snapshot. Re-download the option chain CSV from NSE and import it again.",
    };
  }

  if (rows.length === 0) {
    return {
      ok: false,
      error:
        "No strike rows with option data were found. The file must list strikes with their " +
        "call and/or put values (OI, LTP, volume or similar).",
    };
  }

  if (skipped > 0) {
    warnings.push(`${skipped} row${skipped === 1 ? "" : "s"} without usable strike data skipped.`);
  }

  // ---- contract validation ---------------------------------------------
  if (!symbol) {
    if (rawSymbol && looksLikeSymbol(rawSymbol)) {
      return {
        ok: false,
        error:
          `This file is for "${rawSymbol.trim()}", which this dashboard does not cover. ` +
          `Supported symbols are ${SUPPORTED_SYMBOLS.join(", ")}.`,
      };
    }
    return {
      ok: false,
      error:
        "The file does not name its symbol. Supported symbols are " +
        `${SUPPORTED_SYMBOLS.join(", ")}. Export the NSE option chain page for one of them.`,
    };
  }
  if (!expiry) {
    return {
      ok: false,
      error:
        "The file does not state the expiry date it covers. Add the 'Expiry Date' row " +
        "NSE shows above the option chain, or re-download the CSV from NSE.",
    };
  }
  if (spot === null || spot <= 0) {
    return {
      ok: false,
      error:
        "The file does not include the underlying index value (spot price). NSE shows this " +
        "as 'Underlying Value' above the chain; the dashboard will not invent a spot price.",
    };
  }

  rows.sort((a, b) => a.STRIKE - b.STRIKE);

  const summary = summarizeChain(rows);
  const candidate = {
    symbol,
    expiry,
    spot,
    pcr: summary.pcr,
    max_pain: summary.maxPain,
    total_ce_oi: summary.totalCeOi,
    total_pe_oi: summary.totalPeOi,
    nse_timestamp: exchangeTimestamp,
    updated_at: now.toISOString(),
    raw_data: rows,
  };

  const record = normalizeOptionChainRecord(candidate);
  if (!record) {
    return {
      ok: false,
      error:
        "The parsed chain failed validation. Check that strikes are positive numbers and " +
        "the file covers a single symbol and expiry.",
    };
  }

  return {
    ok: true,
    record,
    meta: {
      symbol: record.symbol,
      expiry: record.expiry,
      spot: record.spot,
      exchangeTimestamp,
      importedAt: now.toISOString(),
      fileName: options.fileName,
      fileSize: options.fileSize,
      rowCount: record.raw_data.length,
      warnings,
    },
  };
}
