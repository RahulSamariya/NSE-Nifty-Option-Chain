import { describe, expect, it } from "vitest";
import {
  canonicalExpiryFromCsv,
  canonicalTimestampFromCsv,
  extractPreambleMetadata,
  inferExpiryFromFileName,
  inferSymbolFromFileName,
  normalizeHeader,
  parseIndianNumber,
  parseNseOptionChainCsv,
  splitCsvRows,
} from "@/lib/nse-csv-import";
import { optionChainToCsv } from "@/lib/option-chain-csv";
import { makeRecord } from "./fixtures";
import * as fx from "./fixtures/nse-csv";

const parse = (text: string, fileName = "chain.csv", fileSize = text.length) =>
  parseNseOptionChainCsv(text, {
    fileName,
    fileSize,
    now: new Date("2026-10-29T10:15:00.000Z"),
  });

describe("splitCsvRows", () => {
  it("splits plain rows on any line ending", () => {
    expect(splitCsvRows("a,b\nc,d\r\ne,f\rg")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g"],
    ]);
  });

  it("keeps commas inside quoted fields and honours doubled quotes", () => {
    expect(splitCsvRows('"1,25,400",50,"say ""hi""",9')).toEqual([
      ["1,25,400", "50", 'say "hi"', "9"],
    ]);
  });

  it("does not treat a quote inside an unquoted field as an opener", () => {
    expect(splitCsvRows('abc"def,2')).toEqual([['abc"def', "2"]]);
  });
});

describe("normalizeHeader", () => {
  it("collapses case, spaces, punctuation and underscores", () => {
    expect(normalizeHeader("Chng in OI")).toBe("chnginoi");
    expect(normalizeHeader(" Strike_Price ")).toBe("strikeprice");
    expect(normalizeHeader("Bid Qty.")).toBe("bidqty");
  });

  it("keeps a percent sign distinguishable from the plain column", () => {
    expect(normalizeHeader("Chng in OI %")).toBe("chnginoipercent");
  });
});

describe("parseIndianNumber", () => {
  it("parses Indian lakh/crore groupings", () => {
    expect(parseIndianNumber("1,25,400")).toBe(125400);
    expect(parseIndianNumber("2,10,900")).toBe(210900);
  });

  it("parses western groupings, decimals and plain numbers", () => {
    expect(parseIndianNumber("26,418.85")).toBe(26418.85);
    expect(parseIndianNumber("12345.67")).toBe(12345.67);
    expect(parseIndianNumber(42)).toBe(42);
  });

  it("parses negatives including parentheses form", () => {
    expect(parseIndianNumber("-1,120")).toBe(-1120);
    expect(parseIndianNumber("(80)")).toBe(-80);
  });

  it("returns null for every missing-value marker", () => {
    for (const marker of ["", "-", "--", "na", "N/A", "nil", "null", "   "]) {
      expect(parseIndianNumber(marker)).toBeNull();
    }
  });

  it("returns null rather than NaN for junk", () => {
    expect(parseIndianNumber("abc")).toBeNull();
    expect(parseIndianNumber("12..3")).toBeNull();
    expect(parseIndianNumber(null)).toBeNull();
  });
});

describe("canonicalExpiryFromCsv", () => {
  it("canonicalises the NSE dd-MMM-yyyy form", () => {
    expect(canonicalExpiryFromCsv("29-Oct-2026")).toBe("29-Oct-2026");
    expect(canonicalExpiryFromCsv("9-Oct-2026")).toBe("09-Oct-2026");
  });

  it("canonicalises ISO and slash date forms", () => {
    expect(canonicalExpiryFromCsv("2026-10-29")).toBe("29-Oct-2026");
    expect(canonicalExpiryFromCsv("29/10/2026")).toBe("29-Oct-2026");
  });

  it("rejects impossible dates", () => {
    expect(canonicalExpiryFromCsv("32-Oct-2026")).toBeNull();
    expect(canonicalExpiryFromCsv("not a date")).toBeNull();
  });
});

describe("parseNseOptionChainCsv - valid layouts", () => {
  it("parses the grouped CALLS/PUTS layout with metadata", () => {
    const result = parse(fx.GROUPED_NIFTY_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.symbol).toBe("NIFTY");
    expect(result.record.expiry).toBe("29-Oct-2026");
    expect(result.record.spot).toBe(26418.85);
    expect(result.record.nse_timestamp).toBe("29-Oct-2026 15:30:00");
    expect(result.meta.fileName).toBe("chain.csv");
    expect(result.meta.rowCount).toBe(4);
    expect(result.record.raw_data.map((r) => r.STRIKE)).toEqual([26000, 26100, 26200, 26300]);
  });

  it("maps Indian numerals and signs onto the right CE/PE fields", () => {
    const result = parse(fx.GROUPED_NIFTY_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = result.record.raw_data[0];
    expect(first.CE_OI).toBe(125400);
    expect(first.CE_CHNG_IN_OI).toBe(15250);
    expect(first.CE_VOLUME).toBe(204150);
    expect(first.CE_LTP).toBe(150.5);
    expect(first.PE_OI).toBe(210900);
    expect(first.PE_CHNG_IN_OI).toBe(-1120);
    expect(first.PE_LTP).toBe(40.2);

    const third = result.record.raw_data[2];
    expect(third.CE_CHNG_IN_OI).toBe(-2100);
    expect(third.PE_OI).toBe(477300);
  });

  it("leaves absent values absent instead of zero", () => {
    const result = parse(fx.GROUPED_NIFTY_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const third = result.record.raw_data[2];
    expect(third.CE_IV).toBeUndefined();
    expect(third.CE_CHNG).toBeUndefined();
    // The put side of row three has no IV, bid, ask or chg-OI.
    expect(third.PE_IV).toBeUndefined();
    expect(third.PE_BID).toBeUndefined();
    expect(third.PE_CHNG_IN_OI).toBeUndefined();
    // ...but its LTP is genuinely present, so it must not be blanked.
    expect(third.PE_LTP).toBe(88.05);
  });

  it("computes PCR and max pain from the parsed OI", () => {
    const result = parse(fx.GROUPED_NIFTY_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const totalCe = 125400 + 240100 + 390500 + 405200;
    const totalPe = 210900 + 305200 + 477300 + 590100;
    expect(result.record.total_ce_oi).toBe(totalCe);
    expect(result.record.total_pe_oi).toBe(totalPe);
    expect(result.record.pcr).toBeCloseTo(totalPe / totalCe, 10);
    // Max pain must be one of the strikes in the file.
    expect([26000, 26100, 26200, 26300]).toContain(result.record.max_pain);
  });

  it("parses the flat duplicated-header layout", () => {
    const result = parse(fx.FLAT_DUP_HEADER_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [a, b] = result.record.raw_data;
    expect(result.record.symbol).toBe("NIFTY");
    expect(a.CE_OI).toBe(10000);
    expect(a.CE_LTP).toBe(120.55);
    expect(a.PE_OI).toBe(9000);
    expect(a.PE_LTP).toBe(30.25);
    expect(b.STRIKE).toBe(26400);
    expect(b.PE_CHNG_IN_OI).toBe(400);
  });

  it("parses the CE_/PE_ prefixed layout for a different symbol", () => {
    const result = parse(fx.PREFIXED_HEADERS_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.symbol).toBe("BANKNIFTY");
    expect(result.record.expiry).toBe("27-Nov-2026");
    const first = result.record.raw_data[0];
    expect(first.CE_OI).toBe(15000);
    expect(first.CE_IV).toBe(13.1);
    expect(first.PE_OI).toBe(18000);
    expect(first.PE_LTP).toBe(145.3);
  });

  it("imports a file with missing IV and keeps IV absent, not zero", () => {
    const result = parse(fx.MISSING_IV_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [a, b] = result.record.raw_data;
    expect(a.CE_IV).toBeUndefined();
    expect(a.PE_IV).toBeUndefined();
    expect(b.CE_IV).toBe(11.8);
    expect(b.PE_IV).toBe(12.6);
  });

  it("handles a UTF-8 BOM and CRLF line endings", () => {
    const result = parse(fx.CRLF_BOM_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.symbol).toBe("NIFTY");
    expect(result.meta.rowCount).toBe(2);
  });

  it("records import time separately and reports no exchange timestamp when absent", () => {
    const result = parse(fx.FLAT_DUP_HEADER_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.nse_timestamp).toBeNull();
    expect(result.meta.exchangeTimestamp).toBeNull();
    expect(result.meta.importedAt).toBe(new Date("2026-10-29T10:15:00.000Z").toISOString());
  });

  it("sorts strikes ascending regardless of file order", () => {
    const shuffled = [
      "Symbol,NIFTY",
      "Expiry Date,29-Oct-2026",
      "Underlying Value,26400",
      "Strike,CE OI,PE OI",
      "26500,6100,5200",
      "26400,5000,4500",
      "26600,7000,6000",
      "",
    ].join("\n");
    const result = parse(shuffled);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.raw_data.map((r) => r.STRIKE)).toEqual([26400, 26500, 26600]);
  });

  it("ignores the identical duplicate row and warns", () => {
    const result = parse(fx.DUPLICATE_IDENTICAL_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.rowCount).toBe(2);
    expect(result.meta.warnings.some((w) => w.includes("identical"))).toBe(true);
  });

  it("skips rows without usable strike data and warns", () => {
    const withBlankRow = [
      "Symbol,NIFTY",
      "Expiry Date,29-Oct-2026",
      "Underlying Value,26400",
      "Strike,CE OI,PE OI",
      "26400,5000,4500",
      "26500,-,-",
      ",,",
      "",
    ].join("\n");
    const result = parse(withBlankRow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.rowCount).toBe(1);
    expect(result.meta.warnings.some((w) => w.includes("skipped"))).toBe(true);
  });

  it("imports a CSV exported by our own dashboard (round-trip compatibility)", () => {
    const original = makeRecord();
    const exportedCsv = optionChainToCsv(original, "Live");

    const result = parse(exportedCsv, "dashboard_export.csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.symbol).toBe(original.symbol);
    expect(result.record.expiry).toBe(original.expiry);
    expect(result.record.spot).toBe(original.spot);
    expect(result.record.nse_timestamp).toBe(original.nse_timestamp);
    expect(result.record.raw_data.length).toBe(original.raw_data.length);
    expect(result.meta.warnings.some((w) => w.includes("table columns"))).toBe(true);
  });

  it("handles multiple key-value pairs in a single preamble row", () => {
    const multiPairCsv = [
      'Symbol,NIFTY,Expiry,29-Oct-2026,Underlying Value,"26,418.85",Timestamp,29-Oct-2026 15:30:00',
      "Strike,CE OI,PE OI",
      "26400,5000,4500",
      "26500,6100,5200",
      "",
    ].join("\n");

    const result = parse(multiPairCsv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.symbol).toBe("NIFTY");
    expect(result.record.expiry).toBe("29-Oct-2026");
    expect(result.record.spot).toBe(26418.85);
    expect(result.record.nse_timestamp).toBe("29-Oct-2026 15:30:00");
    expect(result.meta.rowCount).toBe(2);
  });

  it("handles spacer columns between metadata keys and values", () => {
    const spacerCsv = [
      "Symbol,,,NIFTY",
      "Expiry Date,,,,29-Oct-2026",
      'Underlying Value,,,"26,418.85"',
      "Strike,CE OI,PE OI",
      "26400,5000,4500",
      "",
    ].join("\n");

    const result = parse(spacerCsv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.symbol).toBe("NIFTY");
    expect(result.record.expiry).toBe("29-Oct-2026");
    expect(result.record.spot).toBe(26418.85);
  });

  it("handles colon-separated metadata and timezones", () => {
    const colonCsv = [
      "Symbol: BANKNIFTY",
      "Expiry Date: 27-Nov-2026",
      "Underlying Value: 57,210.50",
      "Last updated at: 27-Nov-2026 15:30:00 IST",
      "Strike,CE OI,PE OI",
      "57000,15000,18000",
      "57200,22000,14000",
      "",
    ].join("\n");

    const result = parse(colonCsv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.symbol).toBe("BANKNIFTY");
    expect(result.record.expiry).toBe("27-Nov-2026");
    expect(result.record.spot).toBe(57210.5);
    expect(result.record.nse_timestamp).toBe("27-Nov-2026 15:30:00");
  });

  it("infers symbol and expiry from filename when omitted in file body", () => {
    const noMetaCsv = [
      "Underlying Value,26400",
      "Strike,CE OI,PE OI",
      "26400,5000,4500",
      "26500,6100,5200",
      "",
    ].join("\n");

    const result = parse(noMetaCsv, "NIFTY_29-Oct-2026.csv");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.record.symbol).toBe("NIFTY");
    expect(result.record.expiry).toBe("29-Oct-2026");
    expect(result.record.spot).toBe(26400);
    expect(result.meta.warnings.some((w) => w.includes('Inferred symbol "NIFTY"'))).toBe(true);
    expect(result.meta.warnings.some((w) => w.includes('Inferred expiry date "29-Oct-2026"'))).toBe(true);
  });
});

describe("inferSymbolFromFileName", () => {
  it("extracts symbols accurately with various delimiters", () => {
    expect(inferSymbolFromFileName("NIFTY_29-Oct-2026.csv")).toBe("NIFTY");
    expect(inferSymbolFromFileName("BANKNIFTY-27-Nov-2026.csv")).toBe("BANKNIFTY");
    expect(inferSymbolFromFileName("bank_nifty_chain.csv")).toBe("BANKNIFTY");
    expect(inferSymbolFromFileName("FINNIFTY-weekly.csv")).toBe("FINNIFTY");
    expect(inferSymbolFromFileName("option-chain-ED-NIFTY-29-Oct-2026.csv")).toBe("NIFTY");
    expect(inferSymbolFromFileName("generic_chain.csv")).toBeNull();
  });
});

describe("inferExpiryFromFileName", () => {
  it("extracts canonical expiries from file names", () => {
    expect(inferExpiryFromFileName("NIFTY_29-Oct-2026.csv")).toBe("29-Oct-2026");
    expect(inferExpiryFromFileName("BANKNIFTY_27_Nov_2026.csv")).toBe("27-Nov-2026");
    expect(inferExpiryFromFileName("FINNIFTY_2026-10-27.csv")).toBe("27-Oct-2026");
    expect(inferExpiryFromFileName("chain_29-10-2026.csv")).toBe("29-Oct-2026");
    expect(inferExpiryFromFileName("just_chain.csv")).toBeNull();
  });
});

describe("canonicalTimestampFromCsv", () => {
  it("parses timestamps with or without timezone abbreviations", () => {
    expect(canonicalTimestampFromCsv("29-Oct-2026 15:30:00")).toBe("29-Oct-2026 15:30:00");
    expect(canonicalTimestampFromCsv("29-Oct-2026 15:30:00 IST")).toBe("29-Oct-2026 15:30:00");
    expect(canonicalTimestampFromCsv("2026-10-29T15:30:00.000Z")).toBe("29-Oct-2026 15:30:00");
  });
});

describe("extractPreambleMetadata", () => {
  it("extracts metadata from isolated rows", () => {
    const meta = extractPreambleMetadata([
      ["Symbol: NIFTY", "Expiry: 29-Oct-2026"],
      ["Underlying Value", "26418.85"],
    ]);
    expect(meta.symbol).toBe("NIFTY");
    expect(meta.expiry).toBe("29-Oct-2026");
    expect(meta.spot).toBe(26418.85);
  });
});

describe("parseNseOptionChainCsv - rejections", () => {
  it("rejects an empty file", () => {
    expect(parse(fx.EMPTY_CSV)).toEqual({
      ok: false,
      error: "This file is empty.",
    });
  });

  it("rejects a whitespace-only file", () => {
    const result = parse(fx.WHITESPACE_CSV);
    expect(result.ok).toBe(false);
  });

  it("rejects a CSV that is not an option chain", () => {
    const result = parse(fx.NOT_A_CHAIN_CSV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/option-chain table was found/i);
    expect(result.error).toMatch(/Strike Price/);
  });

  it("rejects a file with no strike column", () => {
    const result = parse(fx.NO_STRIKE_COLUMN_CSV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Strike Price/i);
  });

  it("rejects a conflicting duplicate strike in plain language", () => {
    const result = parse(fx.DUPLICATE_CONFLICT_CSV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Strike 26400 appears twice with different values/);
    expect(result.error).toMatch(/cannot be trusted as one snapshot/);
  });

  it("rejects a file where every option value is blank", () => {
    const result = parse(fx.BLANK_OPTION_VALUES_CSV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/No strike rows with option data/);
  });

  it("rejects a file that does not name its symbol", () => {
    const result = parse(fx.NO_SYMBOL_CSV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/does not name its symbol/);
  });

  it("rejects an unsupported symbol by name", () => {
    const result = parse(fx.UNSUPPORTED_SYMBOL_CSV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/MIDCPNIFTY/);
    expect(result.error).toMatch(/does not cover/);
  });

  it("rejects a file without the underlying value rather than inventing spot", () => {
    const result = parse(fx.NO_SPOT_CSV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/underlying index value/);
    expect(result.error).toMatch(/will not invent a spot price/);
  });

  it("rejects a file without an expiry", () => {
    const result = parse(fx.NO_EXPIRY_CSV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/does not state the expiry/);
  });

  it("never labels an unsupported-symbol file as simply unparseable", () => {
    // Guards the plain-language promise: the message must guide, not just fail.
    for (const text of [fx.UNSUPPORTED_SYMBOL_CSV, fx.NO_SPOT_CSV, fx.NO_EXPIRY_CSV]) {
      const result = parse(text);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.length).toBeGreaterThan(30);
      expect(result.error).not.toMatch(/undefined|NaN|\[object/i);
    }
  });
});
