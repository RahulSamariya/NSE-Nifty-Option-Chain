import { describe, expect, it } from "vitest";
import { META_COLUMNS, csvColumns, optionChainFileName, optionChainToCsv } from "@/lib/option-chain-csv";
import { makeRecord } from "./fixtures";

describe("optionChainToCsv", () => {
  const record = makeRecord();
  const csv = optionChainToCsv(record, "Last Close");
  const lines = csv.split("\r\n").filter(Boolean);

  it("starts with the metadata columns and then the full chain", () => {
    const header = lines[0].split(",");
    expect(header.slice(0, META_COLUMNS.length)).toEqual([...META_COLUMNS]);
    expect(header).toContain("STRIKE");
    expect(header).toContain("CE_OI");
    expect(header).toContain("PE_ASK_QTY");
    expect(header.length).toBe(META_COLUMNS.length + 25);
  });

  it("writes every strike, not a window around spot", () => {
    expect(lines).toHaveLength(1 + record.raw_data.length);
    expect(lines[1].startsWith("NIFTY,27-Oct-2026,22600,")).toBe(true);
    expect(lines[1].split(",")[META_COLUMNS.length]).toBe("19950");
    expect(lines[3].split(",")[META_COLUMNS.length]).toBe("20050");
  });

  it("carries the source timestamp and honest status on every row", () => {
    for (const line of lines.slice(1)) {
      expect(line).toContain("23-Oct-2026 15:40:00");
      expect(line.includes(",Last Close,")).toBe(true);
    }
  });

  it("uses CRLF and quotes values containing commas", () => {
    expect(csv.endsWith("\r\n")).toBe(true);
    const tricky = makeRecord({
      raw_data: [{ ...makeRecord().raw_data[0], NOTE: 'a,b "quoted"' }],
    });
    const out = optionChainToCsv(tricky, "Stale");
    expect(out).toContain('"a,b ""quoted"""');
  });

  it("lists extra raw keys after the known columns", () => {
    const withExtras = makeRecord({
      raw_data: [{ ...makeRecord().raw_data[0], CE_EXTRA: 7 }],
    });
    expect(csvColumns(withExtras).at(-1)).toBe("CE_EXTRA");
  });
});

describe("optionChainFileName", () => {
  it("keeps the symbol and expiry readable", () => {
    expect(optionChainFileName(makeRecord(), "_snapshot.xlsx")).toBe("NIFTY_27-Oct-2026_snapshot.xlsx");
  });
});
