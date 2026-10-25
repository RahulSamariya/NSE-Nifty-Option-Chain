import { parseSymbolQuery } from "@/lib/api-validation";
import { enforceRateLimit, jsonError, preflight } from "@/lib/api-response";
import {
  SnapshotQueryError,
  createReadClient,
  loadExpiries,
} from "@/lib/option-chain-server";

export function OPTIONS(): Response {
  return preflight();
}

/**
 * GET /api/option-chain/expiries?symbol=NIFTY
 *
 * Expiries that actually exist in `option_chain_live` for the symbol, newest
 * snapshot first. The dashboard builds its expiry selector from this, so it can
 * never offer an expiry that has no data behind it.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseSymbolQuery(url.searchParams);
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
    const expiries = await loadExpiries(client, parsed.value.symbol);
    if (expiries.length === 0) {
      return jsonError(
        404,
        "no_snapshot",
        `No stored snapshot exists for ${parsed.value.symbol}.`,
      );
    }

    return Response.json(
      {
        symbol: parsed.value.symbol,
        generated_at: new Date().toISOString(),
        newest: expiries[0].expiry,
        expiries,
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
      "[api/option-chain/expiries] query failed:",
      error instanceof SnapshotQueryError ? error.message : error,
    );
    return jsonError(
      502,
      "database_error",
      "Could not read the stored expiries. Try again shortly.",
    );
  }
}
