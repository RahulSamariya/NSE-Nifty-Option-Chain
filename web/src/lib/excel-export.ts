import ExcelJS from "exceljs";
import type { OptionChainRecord } from "@/types/option-chain";
import type { SnapshotStatus } from "./market-status";
import {
  CHAIN_FIELDS,
  chainFieldKeys,
  extraFieldKeys,
  numberFormat,
  type FieldSpec,
} from "./option-chain-fields";

export interface WorkbookOptions {
  record: OptionChainRecord;
  status: SnapshotStatus;
  ageSeconds: number | null;
  /** Full CSV endpoint for this snapshot, shown in the summary sheet. */
  csvUrl: string;
  now?: Date;
}

const HEADER_FILL = {
  strike: "FF334155",
  ce: "FF1D4ED8",
  pe: "FFB45309",
  meta: "FF334155",
};

const STATUS_STYLE: Record<SnapshotStatus, { fill: string; text: string }> = {
  Live: { fill: "FFDCFCE7", text: "FF166534" },
  "Last Close": { fill: "FFFEF3C7", text: "FF92400E" },
  Stale: { fill: "FFFEE2E2", text: "FFB91C1C" },
  Unavailable: { fill: "FFF3F4F6", text: "FF4B5563" },
};

function patternFill(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function istString(value: Date | string | null | undefined): string {
  if (!value) return "unknown";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "unknown";
  return (
    date.toLocaleString("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }) + " IST"
  );
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** "47 h 12 min" / "3 min" - a plain-language age for the summary sheet. */
function formatAge(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 0) return "in the future (check the source timestamp)";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

function addSummarySheet(
  workbook: ExcelJS.Workbook,
  { record, status, ageSeconds, csvUrl, now }: WorkbookOptions,
): void {
  const sheet = workbook.addWorksheet("Summary", {
    properties: { tabColor: { argb: "FF059669" }, defaultRowHeight: 18 },
    views: [{ showGridLines: false }],
  });
  sheet.columns = [
    { width: 28 },
    { width: 26 },
    { width: 4 },
    { width: 78 },
  ];

  sheet.mergeCells("A1:D1");
  const title = sheet.getCell("A1");
  title.value = "NSE Option Chain Snapshot";
  title.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  title.fill = patternFill("FF0F172A");
  title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  sheet.getRow(1).height = 32;

  sheet.mergeCells("A2:D2");
  const subtitle = sheet.getCell("A2");
  subtitle.value =
    "Generated from the validated NSE snapshot stored in Supabase. " +
    "This workbook is a point-in-time snapshot and does not update by itself.";
  subtitle.font = { size: 10, color: { argb: "FF475569" } };
  subtitle.alignment = { vertical: "middle", wrapText: true, indent: 1 };
  sheet.getRow(2).height = 28;

  const rows: Array<[string, ExcelJS.CellValue, string?]> = [
    ["Symbol", record.symbol],
    ["Expiry", record.expiry],
    ["Underlying spot", record.spot, "#,##0.00"],
    ["Put-Call Ratio (PCR)", record.pcr, "0.0000"],
    ["Max Pain strike", record.max_pain, "#,##0"],
    ["Total Call OI", record.total_ce_oi, "#,##0"],
    ["Total Put OI", record.total_pe_oi, "#,##0"],
    ["Strikes exported", record.raw_data.length, "#,##0"],
    ["NSE source timestamp", record.nse_timestamp ?? "unavailable"],
    ["Snapshot status", status],
    ["Snapshot age at export", formatAge(ageSeconds)],
    ["Snapshot written (DB)", istString(record.updated_at)],
    ["Workbook built at", istString(now ?? new Date())],
  ];

  rows.forEach(([label, value, fmt], index) => {
    const rowNumber = 4 + index;
    const labelCell = sheet.getCell(rowNumber, 1);
    const valueCell = sheet.getCell(rowNumber, 2);
    labelCell.value = label;
    labelCell.font = { bold: true, color: { argb: "FF334155" } };
    valueCell.value = value as ExcelJS.CellValue;
    if (fmt && typeof value === "number") valueCell.numFmt = fmt;
    if (label === "Snapshot status") {
      const style = STATUS_STYLE[status];
      valueCell.fill = patternFill(style.fill);
      valueCell.font = { bold: true, color: { argb: style.text } };
    }
  });

  const sectionRow = 4 + rows.length + 1; // 17
  const section = sheet.getCell(sectionRow, 1);
  section.value = "Refresh with Excel Power Query";
  section.font = { bold: true, size: 12, color: { argb: "FF0F172A" } };

  const endpointRow = sectionRow + 1;
  sheet.getCell(endpointRow, 1).value = "Stable CSV endpoint";
  sheet.getCell(endpointRow, 1).font = { bold: true, color: { argb: "FF334155" } };
  sheet.mergeCells(endpointRow, 2, endpointRow, 4);
  const endpoint = sheet.getCell(endpointRow, 2);
  endpoint.value = csvUrl;
  endpoint.font = { size: 9, color: { argb: "FF1D4ED8" }, underline: true };
  endpoint.alignment = { wrapText: true };

  const notes = [
    "1. In Excel choose Data > Get Data > From Other Sources > Blank Query > Advanced Editor.",
    "2. Paste the M query from docs/EXCEL_POWER_QUERY.md, using the endpoint above.",
    "3. Load the query into a table. Data > Refresh All then re-reads the newest stored snapshot.",
    "Refreshing re-queries Supabase. It does not make Excel contact NSE; the Python worker does that.",
  ];
  notes.forEach((note, index) => {
    const row = endpointRow + 2 + index;
    sheet.mergeCells(row, 1, row, 4);
    const cell = sheet.getCell(row, 1);
    cell.value = note;
    cell.font = { size: 10, color: { argb: "FF475569" } };
    cell.alignment = { wrapText: true, vertical: "middle", indent: 1 };
  });
}

function addChainSheet(
  workbook: ExcelJS.Workbook,
  { record, status }: WorkbookOptions,
): void {
  const extras = extraFieldKeys(record.raw_data).map<FieldSpec>((key) => ({
    key,
    label: `Extra: ${key}`,
    kind: "decimal",
    width: 14,
  }));
  const fields: FieldSpec[] = [...CHAIN_FIELDS, ...extras];
  const known = new Set(CHAIN_FIELDS.map((field) => field.key));
  const sheet = workbook.addWorksheet("Option Chain", {
    properties: { tabColor: { argb: "FF1D4ED8" } },
    views: [{ state: "frozen", xSplit: 1, ySplit: 1 }],
  });

  sheet.columns = fields.map((field) => ({ width: field.width }));
  const header = sheet.addRow(fields.map((field) => field.label));
  header.height = 26;
  header.eachCell((cell, columnNumber) => {
    const field = fields[columnNumber - 1];
    const isCall = field.key.startsWith("CE_");
    const isPut = field.key.startsWith("PE_");
    cell.fill = patternFill(
      isCall ? HEADER_FILL.ce : isPut ? HEADER_FILL.pe : HEADER_FILL.strike,
    );
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
    };
  });

  const firstDataRow = 2;
  record.raw_data.forEach((strike, index) => {
    const row = sheet.addRow(
      fields.map((field) => {
        const value = strike[field.key];
        if (known.has(field.key)) return numeric(value) ?? null;
        return (value ?? null) as ExcelJS.CellValue;
      }),
    );
    row.height = 17;
    fields.forEach((field, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      if (typeof cell.value === "number" && known.has(field.key)) {
        cell.numFmt = numberFormat(field.kind);
      }
      if (field.key === "STRIKE") {
        cell.font = { bold: true, color: { argb: "FF0F172A" } };
        cell.fill = patternFill("FFF1F5F9");
      }
      if (index % 2 === 1 && field.key !== "STRIKE") {
        cell.fill = patternFill("FFF8FAFC");
      }
    });
  });

  const lastRow = firstDataRow + record.raw_data.length - 1;
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: lastRow, column: fields.length },
  };

  // Colour signed change columns (positive green / negative red).
  let priority = 1;
  fields.forEach((field, index) => {
    if (!field.signed) return;
    const letter = sheet.getColumn(index + 1).letter;
    const ref = `${letter}${firstDataRow}:${letter}${lastRow}`;
    sheet.addConditionalFormatting({
      ref,
      rules: [
        {
          type: "cellIs",
          operator: "greaterThan",
          formulae: ["0"],
          priority: priority++,
          style: { font: { color: { argb: "FF15803D" }, bold: true } },
        },
        {
          type: "cellIs",
          operator: "lessThan",
          formulae: ["0"],
          priority: priority++,
          style: { font: { color: { argb: "FFB91C1C" }, bold: true } },
        },
      ],
    });
  });

  // A small caption above the filter is not possible (header must start row 1),
  // so record the status in the sheet properties instead.
  sheet.headerFooter.oddFooter = `&L${record.symbol} ${record.expiry} - ${status}&RPage &P of &N`;
}

function addRawSheet(
  workbook: ExcelJS.Workbook,
  { record, status, now }: WorkbookOptions,
): void {
  const fields = chainFieldKeys(record.raw_data);
  const sheet = workbook.addWorksheet("Raw Data", {
    properties: { tabColor: { argb: "FF64748B" } },
    views: [{ state: "frozen", xSplit: 2, ySplit: 1 }],
  });

  const metaColumns = [
    "symbol",
    "expiry",
    "spot",
    "pcr",
    "max_pain",
    "total_ce_oi",
    "total_pe_oi",
    "nse_timestamp",
    "snapshot_updated_at",
    "snapshot_read_at",
    "status",
  ];
  const headers = [...metaColumns, ...fields, "raw_row_json"];
  sheet.columns = headers.map((header) => ({
    width: header === "raw_row_json" ? 70 : header === "nse_timestamp" ? 22 : 14,
  }));

  const headerRow = sheet.addRow(headers);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = patternFill(HEADER_FILL.meta);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });

  const readAt = (now ?? new Date()).toISOString();
  const meta: unknown[] = [
    record.symbol,
    record.expiry,
    record.spot,
    record.pcr,
    record.max_pain,
    record.total_ce_oi,
    record.total_pe_oi,
    record.nse_timestamp,
    record.updated_at,
    readAt,
    status,
  ];

  for (const strike of record.raw_data) {
    sheet.addRow([...meta, ...fields.map((key) => strike[key] ?? null), JSON.stringify(strike)]);
  }

  const lastRow = 1 + record.raw_data.length;
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: lastRow, column: headers.length },
  };
}

/** Build the three-sheet snapshot workbook (Summary, Option Chain, Raw Data). */
export async function buildOptionChainWorkbook(
  options: WorkbookOptions,
): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "NSE Option Chain";
  workbook.title = `${options.record.symbol} ${options.record.expiry} snapshot`;
  workbook.subject = "NSE option chain snapshot";
  workbook.description =
    "Snapshot of the validated NSE option chain stored in Supabase. Not a live NSE feed.";
  workbook.created = options.now ?? new Date();
  workbook.modified = options.now ?? new Date();

  addSummarySheet(workbook, options);
  addChainSheet(workbook, options);
  addRawSheet(workbook, options);

  // ExcelJS returns a pooled Node Buffer at runtime; copy it into a plain
  // ArrayBuffer so it is an unambiguous Response body.
  const written = (await workbook.xlsx.writeBuffer()) as unknown as Uint8Array;
  const bytes = new Uint8Array(written.byteLength);
  bytes.set(written);
  return bytes.buffer;
}
