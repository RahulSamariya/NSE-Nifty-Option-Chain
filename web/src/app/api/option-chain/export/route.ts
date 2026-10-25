import { parseOptionChainQuery } from "@/lib/api-validation";
import { enforceRateLimit, jsonError } from "@/lib/api-response";
import {
  fieldGroupLabels,
  rangeLabel,
  selectChainFields,
  selectStrikes,
} from "@/lib/chain-selection";
import { optionChainFileName } from "@/lib/option-chain-csv";
import {
  MAX_EXPORT_STRIKES,
  buildSnapshotMeta,
  createReadClient,
  InvalidSnapshotError,
  loadSnapshot,
} from "@/lib/option-chain-server";
import { buildOptionChainWorkbook } from "@/lib/excel-export";

/**
 * GET /api/option-chain/export?symbol=NIFTY&expiry=27-Oct-2026
 *     &range=all|10|20|30&fields=oi,oi_change,volume,iv,ltp,price_change
 *
 * Three-sheet workbook built from the newest stored snapshot. The Option Chain
 * sheet follows the requested strike range and import fields; Raw Data always
 * keeps every strike and every source field so nothing is silently dropped.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseOptionChainQuery(url.searchParams);
  if (!parsed.ok) {
    return jsonError(parsed.status, parsed.code, parsed.message);
  }

  const limited = enforceRateLimit(request, "export");
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
      "[api/option-chain/export] snapshot read failed:",
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

  if (loaded.record.raw_data.length > MAX_EXPORT_STRIKES) {
    console.error(
      `[api/option-chain/export] refusing oversized snapshot: ${loaded.record.raw_data.length} strikes`,
    );
    return jsonError(
      413,
      "snapshot_too_large",
      "The stored snapshot has more strikes than a workbook may contain.",
    );
  }

  const { range, fields } = parsed.value;
  const meta = buildSnapshotMeta(loaded);
  const chainRows = selectStrikes(loaded.record.raw_data, loaded.record.spot, range);
  const chainFields = selectChainFields(fields);

  const csvUrl = new URL("/api/option-chain", url.origin);
  csvUrl.searchParams.set("symbol", meta.symbol);
  csvUrl.searchParams.set("expiry", meta.expiry);
  csvUrl.searchParams.set("format", "csv");
  csvUrl.searchParams.set("range", range);
  csvUrl.searchParams.set("fields", fields.join(","));

  let workbook: ArrayBuffer;
  try {
    workbook = await buildOptionChainWorkbook({
      record: loaded.record,
      status: meta.status,
      ageSeconds: meta.age_seconds,
      csvUrl: csvUrl.toString(),
      chainRows,
      chainFields,
      rangeLabel: rangeLabel(range),
      fieldsLabel: fieldGroupLabels(fields),
      now: loaded.readAt,
    });
  } catch (error) {
    console.error(
      "[api/option-chain/export] workbook build failed:",
      error instanceof Error ? error.message : error,
    );
    return jsonError(500, "export_failed", "Could not build the Excel workbook.");
  }

  const base = optionChainFileName(loaded.record, "");
  const suffix = range === "all" ? "" : `_atm${range}`;
  const fileName = `${base}${suffix}_snapshot.xlsx`;

  return new Response(workbook, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(workbook.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Snapshot-Status": meta.status,
      "X-Nse-Source-Timestamp": meta.nse_timestamp ?? "unavailable",
      "X-Strike-Range": range,
      "X-Strike-Count": String(chainRows.length),
      "X-Strike-Total": String(meta.strike_count),
      "X-Field-Groups": fields.join(","),
    },
  });
}
