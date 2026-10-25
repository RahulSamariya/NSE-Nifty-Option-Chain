import {
  chainFieldKeys,
} from "@/lib/option-chain-fields";
import { parseOptionChainQuery } from "@/lib/api-validation";
import {
  buildSnapshotMeta,
  createReadClient,
  InvalidSnapshotError,
  loadSnapshot,
} from "@/lib/option-chain-server";
import { optionChainFileName, optionChainToCsv } from "@/lib/option-chain-csv";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * GET /api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=json|csv
 *
 * Read-only view of the newest validated NSE snapshot stored by the Python
 * worker. Omitting `expiry` returns the newest snapshot for the symbol.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseOptionChainQuery(url.searchParams);
  if (!parsed.ok) {
    return errorResponse(parsed.status, parsed.code, parsed.message);
  }

  const client = createReadClient();
  if (!client) {
    return errorResponse(
      503,
      "not_configured",
      "The API has no read-only Supabase credentials configured.",
    );
  }

  let loaded;
  try {
    loaded = await loadSnapshot(
      client,
      parsed.value.symbol,
      parsed.value.expiry,
    );
  } catch (error) {
    console.error(
      "[api/option-chain] snapshot read failed:",
      error instanceof Error ? error.message : error,
    );
    if (error instanceof InvalidSnapshotError) {
      return errorResponse(
        502,
        "invalid_snapshot",
        "The stored snapshot is incomplete and cannot be exported.",
      );
    }
    return errorResponse(
      502,
      "database_error",
      "Could not read the stored snapshot. Try again shortly.",
    );
  }

  if (!loaded) {
    const suffix = parsed.value.expiry ? ` and expiry ${parsed.value.expiry}` : "";
    return errorResponse(
      404,
      "no_snapshot",
      `No stored snapshot exists for ${parsed.value.symbol}${suffix}.`,
    );
  }

  const meta = buildSnapshotMeta(loaded);
  const commonHeaders = {
    ...CORS_HEADERS,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Snapshot-Status": meta.status,
    "X-Nse-Source-Timestamp": meta.nse_timestamp ?? "unavailable",
  };

  if (parsed.value.format === "csv") {
    const csv = optionChainToCsv(loaded.record, meta.status);
    return new Response(csv, {
      status: 200,
      headers: {
        ...commonHeaders,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `inline; filename="${optionChainFileName(loaded.record, ".csv")}"`,
      },
    });
  }

  return Response.json(
    {
      meta,
      fields: chainFieldKeys(loaded.record.raw_data),
      chain: loaded.record.raw_data,
    },
    { status: 200, headers: commonHeaders },
  );
}
