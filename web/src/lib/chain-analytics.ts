/**
 * PCR and max pain for a validated chain.
 *
 * Ported from the tested Python implementation in core/nse_core.py
 * (summarize/max_pain) so an imported CSV snapshot computes exactly the same
 * numbers as the hosted collector path. Both functions are pure and tolerate
 * missing optional fields: a value the file did not supply stays absent rather
 * than being invented.
 */
import type { StrikeRow } from "@/types/option-chain";

function oiOf(row: StrikeRow, key: "CE_OI" | "PE_OI"): number {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export interface ChainSummary {
  totalCeOi: number;
  totalPeOi: number;
  /** PE OI / CE OI; null when there is no call-side OI to divide by. */
  pcr: number | null;
  /** Strike with the lowest total payout to option buyers at expiry. */
  maxPain: number | null;
  /** Strike carrying the largest CE OI, null when no call OI exists. */
  maxCeStrike: number | null;
  /** Strike carrying the largest PE OI, null when no put OI exists. */
  maxPeStrike: number | null;
}

/**
 * Sum of open interest per side plus the ratio between them.
 * Mirrors Python summarize(): PCR is null (not NaN) when CE OI is zero.
 */
export function summarizeChain(rows: readonly StrikeRow[]): ChainSummary {
  let totalCeOi = 0;
  let totalPeOi = 0;
  let maxCeOi = 0;
  let maxPeOi = 0;
  let maxCeStrike: number | null = null;
  let maxPeStrike: number | null = null;

  for (const row of rows) {
    const strike = Number(row.STRIKE);
    const ce = oiOf(row, "CE_OI");
    const pe = oiOf(row, "PE_OI");
    totalCeOi += ce;
    totalPeOi += pe;
    if (ce > maxCeOi) {
      maxCeOi = ce;
      maxCeStrike = strike;
    }
    if (pe > maxPeOi) {
      maxPeOi = pe;
      maxPeStrike = strike;
    }
  }

  return {
    totalCeOi,
    totalPeOi,
    pcr: totalCeOi > 0 ? totalPeOi / totalCeOi : null,
    maxPain: computeMaxPain(rows),
    maxCeStrike,
    maxPeStrike,
  };
}

/**
 * The strike where the total payout to option BUYERS at expiry is lowest.
 *
 * pain(s) = sum over calls of CE_OI * max(0, s - strike)
 *         + sum over puts   of PE_OI * max(0, strike - s)
 *
 * Same definition as Python max_pain(): the first strike reaching the minimum
 * wins, strikes are assumed sorted ascending.
 */
export function computeMaxPain(rows: readonly StrikeRow[]): number | null {
  if (rows.length === 0) return null;

  const strikes = rows.map((row) => Number(row.STRIKE));
  const ceOi = rows.map((row) => oiOf(row, "CE_OI"));
  const peOi = rows.map((row) => oiOf(row, "PE_OI"));

  let bestStrike = strikes[0];
  let bestPain = Number.POSITIVE_INFINITY;

  for (let i = 0; i < strikes.length; i += 1) {
    const candidate = strikes[i];
    let pain = 0;
    for (let j = 0; j < strikes.length; j += 1) {
      if (ceOi[j] > 0) pain += ceOi[j] * Math.max(0, candidate - strikes[j]);
      if (peOi[j] > 0) pain += peOi[j] * Math.max(0, strikes[j] - candidate);
    }
    if (pain < bestPain) {
      bestPain = pain;
      bestStrike = candidate;
    }
  }

  return bestStrike;
}
