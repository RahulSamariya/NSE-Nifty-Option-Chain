/**
 * One schema for the chain, shared by the CSV endpoint and the Excel workbook.
 * Keys are the raw fields stored in Supabase (`raw_data`), so the JSON API, the
 * CSV and the workbook all describe the same columns.
 */

export type ValueKind = "integer" | "decimal" | "percent";

export interface FieldSpec {
  key: string;
  label: string;
  kind: ValueKind;
  width: number;
  /** colour positive/negative values in Excel */
  signed?: boolean;
}

export const STRIKE_FIELD: FieldSpec = {
  key: "STRIKE",
  label: "Strike",
  kind: "integer",
  width: 12,
};

// NSE field order, mirrored for calls and puts.
const SIDE_SPECS: Array<[string, string, ValueKind, number, boolean?]> = [
  ["OI", "OI", "integer", 13],
  ["CHNG_IN_OI", "Chg OI", "integer", 12, true],
  ["PCHNG_IN_OI", "Chg OI %", "percent", 11, true],
  ["VOLUME", "Volume", "integer", 12],
  ["IV", "IV", "decimal", 9],
  ["LTP", "LTP", "decimal", 11],
  ["CHNG", "Change", "decimal", 11, true],
  ["PCHNG", "Change %", "percent", 11, true],
  ["BID_QTY", "Bid Qty", "integer", 11],
  ["BID", "Bid", "decimal", 11],
  ["ASK", "Ask", "decimal", 11],
  ["ASK_QTY", "Ask Qty", "integer", 11],
];

function sideFields(side: "CE" | "PE"): FieldSpec[] {
  return SIDE_SPECS.map(([key, label, kind, width, signed]) => ({
    key: `${side}_${key}`,
    label: `${side} ${label}`,
    kind,
    width,
    signed,
  }));
}

export const CE_FIELDS: FieldSpec[] = sideFields("CE");
export const PE_FIELDS: FieldSpec[] = sideFields("PE");

/** Strike, then every call column, then every put column. */
export const CHAIN_FIELDS: FieldSpec[] = [STRIKE_FIELD, ...CE_FIELDS, ...PE_FIELDS];
export const KNOWN_CHAIN_KEYS = new Set(CHAIN_FIELDS.map((field) => field.key));

export function numberFormat(kind: ValueKind): string {
  if (kind === "integer") return "#,##0";
  if (kind === "percent") return '0.00"%"';
  return "#,##0.00";
}

/** Additional keys found in `raw_data` that are not part of the known schema. */
export function extraFieldKeys(rows: Array<Record<string, unknown>>): string[] {
  const extras = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!KNOWN_CHAIN_KEYS.has(key)) extras.add(key);
    }
  }
  return [...extras].sort();
}

/** Full stable column list: known fields in NSE order, then any extras. */
export function chainFieldKeys(rows: Array<Record<string, unknown>>): string[] {
  return [...CHAIN_FIELDS.map((field) => field.key), ...extraFieldKeys(rows)];
}
