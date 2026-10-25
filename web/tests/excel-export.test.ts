import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildOptionChainWorkbook } from "@/lib/excel-export";
import { CHAIN_FIELDS } from "@/lib/option-chain-fields";
import { makeRecord, makeStrike } from "./fixtures";

const strikes = [19900, 19950, 20000, 20050, 20100, 22600, 25000];
const record = makeRecord({ raw_data: strikes.map((strike) => makeStrike(strike)) });
const now = new Date("2026-10-25T09:30:00Z");

async function build() {
  const bytes = await buildOptionChainWorkbook({
    record,
    status: "Last Close",
    ageSeconds: 60 * 60 * 47,
    csvUrl: "http://localhost:3000/api/option-chain?symbol=NIFTY&expiry=27-Oct-2026&format=csv",
    now,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  return { bytes, workbook };
}

describe("buildOptionChainWorkbook", () => {
  it("produces a real xlsx with the three documented sheets in order", async () => {
    const { bytes, workbook } = await build();
    // PK zip signature: a genuine .xlsx, not CSV renamed.
    expect([...new Uint8Array(bytes, 0, 2)]).toEqual([0x50, 0x4b]);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Summary",
      "Option Chain",
      "Raw Data",
    ]);
  });

  it("summarises the selected symbol, expiry and matching metrics", async () => {
    const { workbook } = await build();
    const summary = workbook.getWorksheet("Summary")!;
    const values = new Map<string, ExcelJS.CellValue>();
    summary.eachRow((row) => {
      const label = row.getCell(1).value;
      if (typeof label === "string") values.set(label, row.getCell(2).value);
    });

    expect(values.get("Symbol")).toBe("NIFTY");
    expect(values.get("Expiry")).toBe("27-Oct-2026");
    expect(values.get("Underlying spot")).toBe(22600);
    expect(values.get("Put-Call Ratio (PCR)")).toBeCloseTo(0.7374, 4);
    expect(values.get("Max Pain strike")).toBe(22700);
    expect(values.get("Total Call OI")).toBe(4093052);
    expect(values.get("Total Put OI")).toBe(3018320);
    expect(values.get("Strikes exported")).toBe(strikes.length);
    expect(values.get("NSE source timestamp")).toBe("23-Oct-2026 15:40:00");
    expect(values.get("Snapshot status")).toBe("Last Close");
    expect(values.get("Snapshot age at export")).toBe("1 d 23 h");
  });

  it("exports every strike, not just the visible ATM window", async () => {
    const { workbook } = await build();
    const chain = workbook.getWorksheet("Option Chain")!;
    expect(chain.rowCount).toBe(1 + strikes.length);
    expect(chain.columnCount).toBe(CHAIN_FIELDS.length);

    const exported = [];
    for (let row = 2; row <= chain.rowCount; row += 1) {
      exported.push(chain.getCell(row, 1).value);
    }
    expect(exported).toEqual(strikes);
  });

  it("freezes the header and strike column, filters the whole table", async () => {
    const { workbook } = await build();
    const chain = workbook.getWorksheet("Option Chain")!;
    const view = chain.views[0];
    expect(view).toMatchObject({ state: "frozen", xSplit: 1, ySplit: 1 });
    expect(chain.autoFilter).toBeTruthy();
    expect(String(chain.autoFilter)).toContain(`${1 + strikes.length}`);
  });

  it("applies number formats and signed-change conditional formatting", async () => {
    const { workbook } = await build();
    const chain = workbook.getWorksheet("Option Chain")!;
    expect(chain.getCell(2, 2).numFmt).toBe("#,##0");
    expect(chain.getCell(2, 6).numFmt).toBe("#,##0.00");
    expect(chain.getCell(2, 4).numFmt).toBe('0.00"%"');

    const refs = (
      chain as unknown as { conditionalFormattings: Array<{ ref: string }> }
    ).conditionalFormattings.map((formatting) => formatting.ref);
    expect(refs.length).toBe(8);
    expect(refs).toContain(`C2:C${1 + strikes.length}`);
  });

  it("keeps a raw, machine-readable copy plus metadata", async () => {
    const { workbook } = await build();
    const raw = workbook.getWorksheet("Raw Data")!;
    expect(raw.rowCount).toBe(1 + strikes.length);
    const headers = raw.getRow(1).values as ExcelJS.CellValue[];
    expect(headers).toContain("snapshot_updated_at");
    expect(headers).toContain("status");
    expect(headers).toContain("raw_row_json");

    const jsonColumn = headers.indexOf("raw_row_json");
    const parsed = JSON.parse(String(raw.getCell(2, jsonColumn).value));
    expect(parsed.STRIKE).toBe(19900);
    expect(parsed.CE_OI).toBe(19900 + 1000);
  });
});
