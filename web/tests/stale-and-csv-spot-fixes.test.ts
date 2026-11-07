import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseNseOptionChainCsv } from "@/lib/nse-csv-import";
import {
  isImportedOptionChainRecord,
  isOptionChainRecord,
  normalizeImportedOptionChainRecord,
  normalizeOptionChainRecord,
} from "@/lib/option-chain-record";
import { selectStrikes } from "@/lib/chain-selection";
import { buildOptionChainWorkbook } from "@/lib/excel-export";
import { MetricsBar } from "@/components/MetricsBar";
import { makeRecord, makeStrike } from "./fixtures";
import * as fx from "./fixtures/nse-csv";

const parse = (text: string, fileName = "chain.csv") =>
  parseNseOptionChainCsv(text, {
    fileName,
    fileSize: text.length,
    now: new Date("2026-10-31T10:15:00.000Z"),
  });

describe("Regression tests: Stale Dashboard UX + Optional CSV Spot", () => {
  // 1. Valid CSV with spot
  it("parses valid CSV with spot and preserves the actual spot value", () => {
    const result = parse(fx.GROUPED_NIFTY_CSV, "nifty.csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.symbol).toBe("NIFTY");
    expect(result.record.expiry).toBe("29-Oct-2026");
    expect(result.record.spot).toBe(26418.85);
    expect(result.meta.spot).toBe(26418.85);
    expect(result.record.raw_data.length).toBeGreaterThan(0);
  });

  // 2. Valid CSV without spot
  it("parses valid CSV without spot and represents missing spot as null, never zero", () => {
    const result = parse(fx.NO_SPOT_CSV, "nifty_no_spot.csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.symbol).toBe("NIFTY");
    expect(result.record.expiry).toBe("29-Oct-2026");
    expect(result.record.spot).toBeNull();
    expect(result.record.spot).not.toBe(0);
    expect(result.meta.spot).toBeNull();
  });

  // 3. Missing spot with otherwise valid option-chain rows
  it("imports option chain rows with complete calls and puts when spot is missing", () => {
    const csv = `Symbol,BANKNIFTY
Expiry Date,27-Nov-2026
Strike,CE OI,CE LTP,PE OI,PE LTP
51000,10000,250.5,12000,180.2
51500,15000,120.0,8000,310.5
`;
    const result = parse(csv, "banknifty.csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.spot).toBeNull();
    expect(result.record.raw_data).toHaveLength(2);
    expect(result.record.raw_data[0].STRIKE).toBe(51000);
    expect(result.record.raw_data[0].CE_OI).toBe(10000);
    expect(result.record.raw_data[0].PE_OI).toBe(12000);
  });

  // 4. PCR and Max Pain with missing spot
  it("computes PCR and Max Pain accurately from rows when spot is missing", () => {
    const result = parse(fx.NO_SPOT_CSV, "no_spot.csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.spot).toBeNull();
    // 4500 PE / 5000 CE = 0.90
    expect(result.record.pcr).toBeCloseTo(0.9, 5);
    expect(result.record.max_pain).toBe(26400);
    expect(result.record.total_ce_oi).toBe(5000);
    expect(result.record.total_pe_oi).toBe(4500);
  });

  // 5. ATM controls with missing spot
  it("defaults to all strikes and avoids fabricating ATM window when spot is null", () => {
    const rows = [
      makeStrike(20000),
      makeStrike(20100),
      makeStrike(20200),
      makeStrike(20300),
    ];
    // selectStrikes with null spot returns all rows
    const selected = selectStrikes(rows, null, "10");
    expect(selected).toHaveLength(rows.length);
    expect(selected.map((r) => r.STRIKE)).toEqual([20000, 20100, 20200, 20300]);
  });

  // 6. Missing IV
  it("preserves missing IV as absent/undefined rather than coercing to 0 or NaN", () => {
    const result = parse(fx.MISSING_IV_CSV, "missing_iv.csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row26400 = result.record.raw_data.find((r) => r.STRIKE === 26400);
    expect(row26400).toBeDefined();
    expect(row26400?.CE_IV).toBeUndefined();
    expect(row26400?.PE_IV).toBeUndefined();
    const row26500 = result.record.raw_data.find((r) => r.STRIKE === 26500);
    expect(row26500?.CE_IV).toBe(11.8);
    expect(row26500?.PE_IV).toBe(12.6);
  });

  // 7. Invalid symbol, expiry and strike structure
  it("rejects files with invalid symbol, missing expiry or corrupt strike structure", () => {
    // Missing symbol
    const noSymbol = parse(fx.NO_SYMBOL_CSV);
    expect(noSymbol.ok).toBe(false);
    if (!noSymbol.ok) {
      expect(noSymbol.error).toMatch(/does not name its symbol/i);
    }

    // Unsupported symbol
    const badSymbol = parse(fx.UNSUPPORTED_SYMBOL_CSV);
    expect(badSymbol.ok).toBe(false);
    if (!badSymbol.ok) {
      expect(badSymbol.error).toMatch(/MIDCPNIFTY/);
    }

    // Missing expiry
    const noExpiry = parse(fx.NO_EXPIRY_CSV);
    expect(noExpiry.ok).toBe(false);
    if (!noExpiry.ok) {
      expect(noExpiry.error).toMatch(/does not state the expiry/i);
    }

    // Missing strike column
    const noStrike = parse(fx.NO_STRIKE_COLUMN_CSV);
    expect(noStrike.ok).toBe(false);
    if (!noStrike.ok) {
      expect(noStrike.error).toMatch(/Strike Price/i);
    }

    // Conflicting duplicate strikes
    const conflict = parse(fx.DUPLICATE_CONFLICT_CSV);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error).toMatch(/appears twice with different values/i);
    }
  });

  // 8. Previous valid import preserved after a failed import
  it("preserves previous valid import when a subsequent import fails", () => {
    let currentImport = parse(fx.GROUPED_NIFTY_CSV);
    expect(currentImport.ok).toBe(true);

    // User attempts to upload invalid file
    const failedImport = parse(fx.NOT_A_CHAIN_CSV);
    expect(failedImport.ok).toBe(false);

    // If import failed, handler does not overwrite currentImport
    if (failedImport.ok) {
      currentImport = failedImport;
    }
    expect(currentImport.ok).toBe(true);
    if (!currentImport.ok) return;
    expect(currentImport.record.symbol).toBe("NIFTY");
    expect(currentImport.record.spot).toBe(26418.85);
  });

  // 9. Stale dashboard hides current metrics by default
  it("replaces KPI numbers with unmistakable stale/unavailable state when status is Stale and collapsed", () => {
    const markup = renderToStaticMarkup(
      React.createElement(MetricsBar, {
        symbol: "NIFTY",
        spot: 22600,
        pcr: 0.74,
        maxPain: 22700,
        totalCeOi: 4093052,
        totalPeOi: 3018320,
        isStale: true,
        isHistoricalExpanded: false,
      }),
    );

    // Should NOT prominently display the normal KPI numbers as live
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Data Stale — Feed Paused");
    expect(markup).toContain("Stale");
    expect(markup).not.toContain("22,600.00");
    expect(markup).not.toContain("0.74");
  });

  // 10. Explicit historical snapshot expansion
  it("displays historical snapshot values with explicit historical labelling when expanded", () => {
    const markup = renderToStaticMarkup(
      React.createElement(MetricsBar, {
        symbol: "NIFTY",
        spot: 22600,
        pcr: 0.74,
        maxPain: 22700,
        totalCeOi: 4093052,
        totalPeOi: 3018320,
        isStale: true,
        isHistoricalExpanded: true,
      }),
    );

    // Values appear with Historical labelling
    expect(markup).toContain("22,600.00");
    expect(markup).toContain("0.74");
    expect(markup).toContain("22,700");
    expect(markup).toContain("Historical");
    expect(markup).toContain("Historical Spot Index");
  });

  // 11. Fresh status restores normal rendering
  it("restores normal live dashboard metrics automatically when status is fresh", () => {
    const markup = renderToStaticMarkup(
      React.createElement(MetricsBar, {
        symbol: "NIFTY",
        spot: 22600,
        pcr: 0.74,
        maxPain: 22700,
        totalCeOi: 4093052,
        totalPeOi: 3018320,
        isStale: false,
        isHistoricalExpanded: false,
      }),
    );

    expect(markup).toContain("22,600.00");
    expect(markup).toContain("0.74");
    expect(markup).toContain("22,700");
    expect(markup).toContain("Underlying Spot Index");
    expect(markup).not.toContain("Historical");
    expect(markup).not.toContain("Data Stale");
  });

  // 12. Stale Excel export warning
  it("adds clear staleness warning in Excel export when snapshot status is Stale", async () => {
    const record = makeRecord();
    const buffer = await buildOptionChainWorkbook({
      record,
      status: "Stale",
      ageSeconds: 500000,
      csvUrl: "http://localhost/api/option-chain",
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const summary = workbook.getWorksheet("Summary");
    expect(summary).toBeDefined();

    const subtitle = summary?.getCell("A2").value as string;
    expect(subtitle).toMatch(/WARNING.*STALE/i);

    // Check row warning
    let foundWarningRow = false;
    summary?.eachRow((row) => {
      const label = row.getCell(1).value;
      const val = row.getCell(2).value;
      if (label === "Stale Data Warning" || (typeof val === "string" && val.includes("STALE"))) {
        foundWarningRow = true;
      }
    });
    expect(foundWarningRow).toBe(true);
  });

  // 13. Strict positive-spot validation still applies to Supabase snapshots
  it("strictly enforces positive spot for server-originated Supabase snapshots", () => {
    const base = makeRecord();

    // isOptionChainRecord strictly rejects missing or zero spot
    expect(isOptionChainRecord({ ...base, spot: null })).toBe(false);
    expect(isOptionChainRecord({ ...base, spot: undefined })).toBe(false);
    expect(isOptionChainRecord({ ...base, spot: 0 })).toBe(false);
    expect(isOptionChainRecord({ ...base, spot: -100 })).toBe(false);
    expect(isOptionChainRecord(base)).toBe(true);

    // normalizeOptionChainRecord strictly rejects missing or zero spot
    expect(normalizeOptionChainRecord({ ...base, spot: null })).toBeNull();
    expect(normalizeOptionChainRecord({ ...base, spot: 0 })).toBeNull();
    expect(normalizeOptionChainRecord({ ...base, spot: -50 })).toBeNull();
    expect(normalizeOptionChainRecord(base)).not.toBeNull();

    // In contrast, imported snapshot guard allows spot: null
    expect(isImportedOptionChainRecord({ ...base, spot: null })).toBe(true);
    expect(normalizeImportedOptionChainRecord({ ...base, spot: null })?.spot).toBeNull();
  });
});
