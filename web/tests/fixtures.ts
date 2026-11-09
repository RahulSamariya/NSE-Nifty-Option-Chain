import type { OptionChainHistoryPoint, OptionChainRecord, StrikeRow } from "@/types/option-chain";

export function makeStrike(strike: number, overrides: Partial<StrikeRow> = {}): StrikeRow {
  return {
    STRIKE: strike,
    CE_OI: 1000 + strike,
    CE_CHNG_IN_OI: 120,
    CE_PCHNG_IN_OI: 4.5,
    CE_VOLUME: 5000,
    CE_IV: 12.34,
    CE_LTP: 101.5,
    CE_CHNG: 2.5,
    CE_PCHNG: 2.1,
    CE_BID: 101.4,
    CE_BID_QTY: 50,
    CE_ASK: 101.6,
    CE_ASK_QTY: 75,
    PE_OI: 2000 + strike,
    PE_CHNG_IN_OI: -80,
    PE_PCHNG_IN_OI: -3.2,
    PE_VOLUME: 4000,
    PE_IV: 13.21,
    PE_LTP: 88.25,
    PE_CHNG: -1.25,
    PE_PCHNG: -1.4,
    PE_BID: 88.2,
    PE_BID_QTY: 25,
    PE_ASK: 88.3,
    PE_ASK_QTY: 35,
    ...overrides,
  };
}

/**
 * A small but complete snapshot. Strikes 19950, 20000, 20050... mirror the real
 * stored shape (all fields present, NO extras) so tests assert the same columns
 * the worker actually writes.
 */
export function makeRecord(overrides: Partial<OptionChainRecord> = {}): OptionChainRecord {
  return {
    symbol: "NIFTY",
    expiry: "27-Oct-2026",
    spot: 22600,
    pcr: 0.7374252758088585,
    max_pain: 22700,
    total_ce_oi: 4093052,
    total_pe_oi: 3018320,
    nse_timestamp: "23-Oct-2026 15:40:00",
    updated_at: "2026-10-25T09:17:44.856614+00:00",
    raw_data: [makeStrike(19950), makeStrike(20000), makeStrike(20050)],
    ...overrides,
  };
}

/** One intraday history row exactly as `/api/option-chain/history` returns it. */
export function makeHistoryPoint(
  overrides: Partial<OptionChainHistoryPoint> = {},
): OptionChainHistoryPoint {
  return {
    id: 100,
    symbol: "NIFTY",
    expiry: "09-Nov-2026",
    spot: 25004.1,
    pcr: 0.9858,
    max_pain: 24950,
    total_ce_oi: 4890804,
    total_pe_oi: 4821321,
    nse_timestamp: "09-Nov-2026 14:50:58",
    created_at: "2026-11-09T09:22:04.568489+00:00",
    ...overrides,
  };
}
