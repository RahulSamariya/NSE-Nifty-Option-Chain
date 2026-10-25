import { enforceRateLimit, jsonError, preflight } from "@/lib/api-response";
import { createReadClient } from "@/lib/option-chain-server";
import { getSnapshotFreshness, isIndianMarketOpen } from "@/lib/market-status";

export function OPTIONS(): Response {
  return preflight();
}

interface LiveRow {
  symbol: string;
  expiry: string;
  spot: number | string | null;
  nse_timestamp: string | null;
  updated_at: string | null;
}

function writeAgeState(seconds: number | null): "never" | "running" | "delayed" | "stalled" {
  if (seconds === null) return "never";
  if (seconds <= 600) return "running";
  if (seconds <= 3600) return "delayed";
  return "stalled";
}

/**
 * GET /api/health
 *
 * Deployment evidence, not a market feed: reports what the last stored write
 * was, how old it is, and the freshness of every symbol. Secrets are never
 * included. Use it to prove a hosted collector is actually writing.
 */
export async function GET(request: Request): Promise<Response> {
  const limited = enforceRateLimit(request, "read");
  if (limited) return limited;

  const client = createReadClient();
  if (!client) {
    return jsonError(
      503,
      "not_configured",
      "The API has no read-only Supabase credentials configured.",
    );
  }

  const now = new Date();
  let rows: LiveRow[];
  try {
    const { data, error } = await client
      .from("option_chain_live")
      .select("symbol,expiry,spot,nse_timestamp,updated_at")
      .order("updated_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    rows = Array.isArray(data) ? (data as LiveRow[]) : [];
  } catch (error) {
    console.error(
      "[api/health] snapshot health query failed:",
      error instanceof Error ? error.message : error,
    );
    return jsonError(
      502,
      "database_error",
      "Could not read snapshot health. Try again shortly.",
    );
  }

  const symbols = rows.map((row) => {
    const freshness = getSnapshotFreshness(row.nse_timestamp, now);
    const writtenMs = row.updated_at ? Date.parse(row.updated_at) : NaN;
    const writeAgeSeconds = Number.isFinite(writtenMs)
      ? Math.max(0, Math.round((now.getTime() - writtenMs) / 1000))
      : null;
    return {
      symbol: row.symbol,
      expiry: row.expiry,
      spot: row.spot === null ? null : Number(row.spot),
      nse_timestamp: row.nse_timestamp,
      snapshot_updated_at: row.updated_at,
      source_age_seconds: freshness.ageSeconds,
      write_age_seconds: writeAgeSeconds,
      status: freshness.status,
      status_reason: freshness.reason,
      market_open: freshness.marketOpen,
    };
  });

  const writeAges = symbols
    .map((entry) => entry.write_age_seconds)
    .filter((value): value is number => value !== null);
  const freshestWrite = writeAges.length > 0 ? Math.min(...writeAges) : null;
  const lastWriteAt =
    rows
      .map((row) => row.updated_at)
      .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
      .sort()
      .at(-1) ?? null;
  const marketOpen = isIndianMarketOpen(now);

  const healthy = symbols.some(
    (entry) => entry.status === "Live" || entry.status === "Last Close",
  );
  const workerState = writeAgeState(freshestWrite);

  return Response.json(
    {
      status: symbols.length === 0 ? "unavailable" : healthy ? "ok" : "degraded",
      generated_at: now.toISOString(),
      market_open: marketOpen,
      database: { reachable: true, rows: symbols.length },
      worker: {
        state: workerState,
        last_write_at: lastWriteAt,
        seconds_since_write: freshestWrite,
        note: marketOpen
          ? "Market is open: a healthy collector writes every few minutes."
          : "Market is closed: a sleeping collector is expected; freshness is judged from the NSE close timestamp.",
      },
      symbols,
    },
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
