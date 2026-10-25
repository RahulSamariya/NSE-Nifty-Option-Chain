import { parseHistoryQuery } from "@/lib/api-validation";
import { enforceRateLimit, jsonError, preflight } from "@/lib/api-response";
import {
  createReadClient,
  loadHistory,
} from "@/lib/option-chain-server";

export function OPTIONS(): Response {
  return preflight();
}

/**
 * GET /api/option-chain/history?symbol=NIFTY&expiry=27-Oct-2026&limit=60
 *
 * Intraday samples the worker wrote to `option_chain_history`, oldest first, so
 * the dashboard charts come from the same hosted API as everything else and the
 * browser never needs a database credential.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseHistoryQuery(url.searchParams);
  if (!parsed.ok) {
    return jsonError(parsed.status, parsed.code, parsed.message);
  }

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

  try {
    const points = await loadHistory(
      client,
      parsed.value.symbol,
      parsed.value.expiry,
      parsed.value.limit,
    );

    return Response.json(
      {
        meta: {
          symbol: parsed.value.symbol,
          expiry: parsed.value.expiry,
          limit: parsed.value.limit,
          count: points.length,
          generated_at: new Date().toISOString(),
          source: "supabase:option_chain_history",
        },
        points,
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
  } catch (error) {
    console.error(
      "[api/option-chain/history] query failed:",
      error instanceof Error ? error.message : error,
    );
    return jsonError(
      502,
      "database_error",
      "Could not read the stored history. Try again shortly.",
    );
  }
}
