import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { OptionChainHistoryPoint, OptionChainRecord } from "@/types/option-chain";
import { expiryVariants } from "./api-validation";
import {
  getSnapshotFreshness,
  type FreshnessReason,
  type SnapshotFreshness,
  type SnapshotStatus,
} from "./market-status";
import { normalizeOptionChainRecord } from "./option-chain-record";

export class SnapshotQueryError extends Error {}

export class InvalidSnapshotError extends Error {}

/** Response-size guard: no real chain is this large, so treat it as abuse/bad data. */
export const MAX_EXPORT_STRIKES = 2000;
export const MAX_CHAIN_STRIKES = 5000;

export interface LoadedSnapshot {
  record: OptionChainRecord;
  freshness: SnapshotFreshness;
  readAt: Date;
}

export interface SnapshotMeta {
  symbol: string;
  expiry: string;
  spot: number;
  pcr: number | null;
  max_pain: number | null;
  total_ce_oi: number;
  total_pe_oi: number;
  nse_timestamp: string | null;
  snapshot_updated_at: string;
  generated_at: string;
  status: SnapshotStatus;
  market_open: boolean;
  status_reason: FreshnessReason;
  age_seconds: number | null;
  strike_count: number;
  source: "supabase:option_chain_live";
}

/**
 * Server-side read client. The anon key is a public, RLS-restricted key: it can
 * only read. No service-role credential is ever used or returned by the API.
 */
export function createReadClient(): SupabaseClient | null {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Read the newest stored snapshot for a symbol (optionally one expiry). Throws
 * only for infrastructure/data problems; a genuinely missing snapshot is null.
 */
export async function loadSnapshot(
  client: SupabaseClient,
  symbol: string,
  expiry: string | null,
  now = new Date(),
): Promise<LoadedSnapshot | null> {
  let query = client.from("option_chain_live").select("*").eq("symbol", symbol);
  if (expiry) query = query.in("expiry", expiryVariants(expiry));

  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(10);

  if (error) {
    throw new SnapshotQueryError(error.message || "Supabase query failed");
  }

  const rows = Array.isArray(data) ? data : [];
  for (const row of rows) {
    const record = normalizeOptionChainRecord(row);
    if (record) {
      return {
        record,
        freshness: getSnapshotFreshness(record.nse_timestamp, now),
        readAt: now,
      };
    }
  }

  if (rows.length > 0) {
    throw new InvalidSnapshotError("Stored row is not a usable option-chain snapshot");
  }
  return null;
}

export function buildSnapshotMeta({ record, freshness, readAt }: LoadedSnapshot): SnapshotMeta {
  return {
    symbol: record.symbol,
    expiry: record.expiry,
    spot: record.spot,
    pcr: record.pcr,
    max_pain: record.max_pain,
    total_ce_oi: record.total_ce_oi,
    total_pe_oi: record.total_pe_oi,
    nse_timestamp: record.nse_timestamp,
    snapshot_updated_at: record.updated_at,
    generated_at: readAt.toISOString(),
    status: freshness.status,
    market_open: freshness.marketOpen,
    status_reason: freshness.reason,
    age_seconds: freshness.ageSeconds,
    strike_count: record.raw_data.length,
    source: "supabase:option_chain_live",
  };
}

export interface ExpiryOption {
  expiry: string;
  nse_timestamp: string | null;
  snapshot_updated_at: string;
}

/**
 * Expiries that actually exist in `option_chain_live` for this symbol, newest
 * snapshot first. Never synthesised from a calendar.
 */
export async function loadExpiries(
  client: SupabaseClient,
  symbol: string,
): Promise<ExpiryOption[]> {
  const { data, error } = await client
    .from("option_chain_live")
    .select("expiry,nse_timestamp,updated_at")
    .eq("symbol", symbol)
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) {
    throw new SnapshotQueryError(error.message || "Supabase query failed");
  }

  const seen = new Set<string>();
  const options: ExpiryOption[] = [];
  for (const row of Array.isArray(data) ? data : []) {
    const expiry = typeof row.expiry === "string" ? row.expiry.trim() : "";
    if (!expiry || seen.has(expiry)) continue;
    seen.add(expiry);
    options.push({
      expiry,
      nse_timestamp: typeof row.nse_timestamp === "string" ? row.nse_timestamp : null,
      snapshot_updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
    });
  }
  return options;
}

/**
 * Intraday snapshots for the charts, oldest first. Empty array is a normal
 * answer (the worker samples every few minutes; a fresh symbol may have none).
 */
export async function loadHistory(
  client: SupabaseClient,
  symbol: string,
  expiry: string,
  limit: number,
): Promise<OptionChainHistoryPoint[]> {
  const { data, error } = await client
    .from("option_chain_history")
    .select("*")
    .eq("symbol", symbol)
    .in("expiry", expiryVariants(expiry))
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new SnapshotQueryError(error.message || "Supabase history query failed");
  }

  const rows = Array.isArray(data) ? data : [];
  return rows.reverse() as OptionChainHistoryPoint[];
}

