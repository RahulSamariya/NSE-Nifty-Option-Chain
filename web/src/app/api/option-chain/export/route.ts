import { parseOptionChainQuery } from "@/lib/api-validation";
import {
  buildSnapshotMeta,
  createReadClient,
  InvalidSnapshotError,
  loadSnapshot,
} from "@/lib/option-chain-server";
import { optionChainFileName } from "@/lib/option-chain-csv";
import { buildOptionChainWorkbook } from "@/lib/excel-export";

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/**
 * GET /api/option-chain/export?symbol=NIFTY&expiry=27-Oct-2026
 *
 * Three-sheet workbook (Summary / Option Chain / Raw Data) built from the
 * newest stored snapshot. Every strike in the snapshot is exported, regardless
 * of the strike range selected in the browser.
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
      "[api/option-chain/export] snapshot read failed:",
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

  const csvUrl = new URL("/api/option-chain", url.origin);
  csvUrl.searchParams.set("symbol", meta.symbol);
  csvUrl.searchParams.set("expiry", meta.expiry);
  csvUrl.searchParams.set("format", "csv");

  let workbook: ArrayBuffer;
  try {
    workbook = await buildOptionChainWorkbook({
      record: loaded.record,
      status: meta.status,
      ageSeconds: meta.age_seconds,
      csvUrl: csvUrl.toString(),
      now: loaded.readAt,
    });
  } catch (error) {
    console.error(
      "[api/option-chain/export] workbook build failed:",
      error instanceof Error ? error.message : error,
    );
    return errorResponse(
      500,
      "export_failed",
      "Could not build the Excel workbook.",
    );
  }

  return new Response(workbook, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${optionChainFileName(loaded.record, "_snapshot.xlsx")}"`,
      "Content-Length": String(workbook.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Snapshot-Status": meta.status,
      "X-Nse-Source-Timestamp": meta.nse_timestamp ?? "unavailable",
    },
  });
}
