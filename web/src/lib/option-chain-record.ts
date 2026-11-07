import type {
  OptionChainRecord,
  ServerOptionChainRecord,
  StrikeRow,
} from "@/types/option-chain";

export type RawStrikeRow = StrikeRow & Record<string, unknown>;

/** Coerce PostgREST numerics (numbers or numeric strings) to a finite number. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isStrikeRow(value: unknown): value is RawStrikeRow {
  if (!value || typeof value !== "object") return false;
  const strike = toFiniteNumber((value as Record<string, unknown>).STRIKE);
  return strike !== null && strike > 0;
}

/**
 * Strict guard used for server-side Supabase production snapshots. A stored
 * snapshot is only usable when it has a positive spot price and at least one
 * real strike row - no placeholders.
 */
export function isOptionChainRecord(
  value: unknown,
  symbol?: string,
): value is ServerOptionChainRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ServerOptionChainRecord> & Record<string, unknown>;
  if (typeof row.symbol !== "string" || !row.symbol.trim()) return false;
  if (symbol !== undefined && row.symbol !== symbol) return false;
  if (typeof row.expiry !== "string" || !row.expiry.trim()) return false;

  const spot = toFiniteNumber(row.spot);
  if (spot === null || spot <= 0) return false;

  return (
    Array.isArray(row.raw_data) &&
    row.raw_data.length > 0 &&
    row.raw_data.every(isStrikeRow)
  );
}

/**
 * Validate and normalise a row coming from Supabase: numeric strings become
 * numbers and strikes are sorted so every consumer sees the same order.
 * Returns null for anything that is not a genuine snapshot with a strictly positive spot.
 */
export function normalizeOptionChainRecord(
  value: unknown,
): ServerOptionChainRecord | null {
  if (!isOptionChainRecord(value)) return null;
  const row = value as ServerOptionChainRecord;

  const raw = [...row.raw_data]
    .filter(isStrikeRow)
    .map((strike) => ({ ...strike, STRIKE: Number(strike.STRIKE) }))
    .sort((a, b) => a.STRIKE - b.STRIKE);

  return {
    symbol: row.symbol.trim().toUpperCase(),
    expiry: row.expiry.trim(),
    spot: Number(row.spot),
    pcr: toFiniteNumber(row.pcr),
    max_pain: toFiniteNumber(row.max_pain),
    total_ce_oi: toFiniteNumber(row.total_ce_oi) ?? 0,
    total_pe_oi: toFiniteNumber(row.total_pe_oi) ?? 0,
    nse_timestamp: typeof row.nse_timestamp === "string" ? row.nse_timestamp : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
    raw_data: raw,
  };
}

/**
 * Guard for imported CSV snapshots. Spot is optional (can be null), but if
 * present must be a positive number. Symbol, expiry and valid strike structure
 * remain strictly required.
 */
export function isImportedOptionChainRecord(
  value: unknown,
  symbol?: string,
): value is OptionChainRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<OptionChainRecord> & Record<string, unknown>;
  if (typeof row.symbol !== "string" || !row.symbol.trim()) return false;
  if (symbol !== undefined && row.symbol !== symbol) return false;
  if (typeof row.expiry !== "string" || !row.expiry.trim()) return false;

  if (row.spot !== null && row.spot !== undefined) {
    const spot = toFiniteNumber(row.spot);
    if (spot === null || spot <= 0) return false;
  }

  return (
    Array.isArray(row.raw_data) &&
    row.raw_data.length > 0 &&
    row.raw_data.every(isStrikeRow)
  );
}

/**
 * Validate and normalise an imported CSV snapshot. Missing spot is represented
 * strictly as null, never zero.
 */
export function normalizeImportedOptionChainRecord(
  value: unknown,
): OptionChainRecord | null {
  if (!isImportedOptionChainRecord(value)) return null;
  const row = value as OptionChainRecord;

  const raw = [...row.raw_data]
    .filter(isStrikeRow)
    .map((strike) => ({ ...strike, STRIKE: Number(strike.STRIKE) }))
    .sort((a, b) => a.STRIKE - b.STRIKE);

  const rawSpot =
    row.spot !== null && row.spot !== undefined ? toFiniteNumber(row.spot) : null;
  const spot = rawSpot !== null && rawSpot > 0 ? rawSpot : null;

  return {
    symbol: row.symbol.trim().toUpperCase(),
    expiry: row.expiry.trim(),
    spot,
    pcr: toFiniteNumber(row.pcr),
    max_pain: toFiniteNumber(row.max_pain),
    total_ce_oi: toFiniteNumber(row.total_ce_oi) ?? 0,
    total_pe_oi: toFiniteNumber(row.total_pe_oi) ?? 0,
    nse_timestamp: typeof row.nse_timestamp === "string" ? row.nse_timestamp : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
    raw_data: raw,
  };
}
