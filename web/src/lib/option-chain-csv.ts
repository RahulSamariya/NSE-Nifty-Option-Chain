import type { OptionChainRecord } from "@/types/option-chain";
import type { SnapshotStatus } from "./market-status";
import { chainFieldKeys } from "./option-chain-fields";

/** Metadata columns repeated on every CSV row so the file is self-describing. */
export const META_COLUMNS = [
  "symbol",
  "expiry",
  "spot",
  "pcr",
  "max_pain",
  "total_ce_oi",
  "total_pe_oi",
  "nse_timestamp",
  "snapshot_updated_at",
  "status",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvColumns(record: OptionChainRecord): string[] {
  return [...META_COLUMNS, ...chainFieldKeys(record.raw_data)];
}

/** Flat, self-describing CSV: metadata columns first, then the whole chain. */
export function optionChainToCsv(
  record: OptionChainRecord,
  status: SnapshotStatus,
): string {
  const fields = chainFieldKeys(record.raw_data);
  const header = [...META_COLUMNS, ...fields];
  const lines: string[] = [header.map(csvCell).join(",")];

  for (const strike of record.raw_data) {
    const row: unknown[] = [
      record.symbol,
      record.expiry,
      record.spot,
      record.pcr,
      record.max_pain,
      record.total_ce_oi,
      record.total_pe_oi,
      record.nse_timestamp,
      record.updated_at,
      status,
    ];
    for (const key of fields) row.push(strike[key] ?? null);
    lines.push(row.map(csvCell).join(","));
  }

  // CRLF keeps Excel's own CSV import happy on every platform.
  return lines.join("\r\n") + "\r\n";
}

export function optionChainFileName(record: OptionChainRecord, extension: string): string {
  const safe = `${record.symbol}_${record.expiry}`.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${safe}${extension}`;
}
