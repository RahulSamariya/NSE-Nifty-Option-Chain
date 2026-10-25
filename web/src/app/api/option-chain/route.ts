import { parseOptionChainQuery } from "@/lib/api-validation";
import {
  CORS_HEADERS,
  enforceRateLimit,
  jsonError,
  preflight,
} from "@/lib/api-response";
import {
  fieldGroupLabels,
  pickFields,
  rangeLabel,
  selectChainFields,
  selectStrikes,
} from "@/lib/chain-selection";
import { optionChainFileName, optionChainToCsv } from "@/lib/option-chain-csv";
import {
  MAX_CHAIN_STRIKES,
  buildSnapshotMeta,
  createReadClient,
  InvalidSnapshotError,
  loadSnapshot,
} from "@/lib/option-chain-server";

export function OPTIONS(): Response {
  return preflight();
}

/**
 * GET /api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=json|csv
 *     &range=all|10|20|30&fields=oi,oi_change,volume,iv,ltp,price_change,bid_ask
 *
 * Read-only view of the newest validated NSE snapshot stored by the Python
 * worker. Omitting `expiry` returns the newest snapshot for the symbol.
 * `range` and `fields` only narrow what is returned; the stored snapshot is
 * never modified.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseOptionChainQuery(url.searchParams);
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
      return jsonError(
        502,
        "invalid_snapshot",
        "The stored snapshot is incomplete and cannot be exported.",
      );
    }
    return jsonError(
      502,
      "database_error",
      "Could not read the stored snapshot. Try again shortly.",
    );
  }

  if (!loaded) {
    const suffix = parsed.value.expiry ? ` and expiry ${parsed.value.expiry}` : "";
    return jsonError(
      404,
      "no_snapshot",
      `No stored snapshot exists for ${parsed.value.symbol}${suffix}.`,
    );
  }

  if (loaded.record.raw_data.length > MAX_CHAIN_STRIKES) {
    console.error(
      `[api/option-chain] refusing oversized snapshot: ${loaded.record.raw_data.length} strikes`,
    );
    return jsonError(
      413,
      "snapshot_too_large",
      "The stored snapshot has more strikes than this API will serve.",
    );
  }

  const { range, fields } = parsed.value;
  const chainFields = selectChainFields(fields);
  const chainRows = selectStrikes(loaded.record.raw_data, loaded.record.spot, range);

  const meta = {
    ...buildSnapshotMeta(loaded),
    strike_range: range,
    strike_range_label: rangeLabel(range),
    field_groups: fields,
    fields_label: fieldGroupLabels(fields),
    strikes_returned: chainRows.length,
  };

  const commonHeaders = {
    ...CORS_HEADERS,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Snapshot-Status": meta.status,
    "X-Nse-Source-Timestamp": meta.nse_timestamp ?? "unavailable",
    "X-Strike-Range": range,
    "X-Strike-Count": String(meta.strikes_returned),
    "X-Strike-Total": String(meta.strike_count),
  };

  if (parsed.value.format === "csv") {
    const keys = chainFields.map((field) => field.key);
    const csv = optionChainToCsv(loaded.record, meta.status, keys, chainRows);
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
      fields: chainFields.map((field) => field.key),
      chain: chainRows.map((row) => pickFields(row, chainFields)),
    },
    { status: 200, headers: commonHeaders },
  );
}
