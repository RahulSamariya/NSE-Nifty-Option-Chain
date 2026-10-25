import type { OptionChainRecord, StrikeRow } from "@/types/option-chain";

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
 * Guard used by the dashboard and the API. A snapshot is only usable when it
 * has a positive spot and at least one real strike row - no placeholders.
 */
export function isOptionChainRecord(
  value: unknown,
  symbol?: string,
): value is OptionChainRecord {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<OptionChainRecord> & Record<string, unknown>;
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
 * Returns null for anything that is not a genuine snapshot.
 */
export function normalizeOptionChainRecord(value: unknown): OptionChainRecord | null {
  if (!isOptionChainRecord(value)) return null;
  const row = value as OptionChainRecord;

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
