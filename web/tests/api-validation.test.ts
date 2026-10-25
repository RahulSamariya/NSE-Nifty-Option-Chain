import { describe, expect, it } from "vitest";
import { canonicalExpiry, expiryVariants, parseOptionChainQuery } from "@/lib/api-validation";

const parse = (query: string) => parseOptionChainQuery(new URLSearchParams(query));

describe("parseOptionChainQuery", () => {
  it("accepts the documented query", () => {
    const result = parse("symbol=NIFTY&expiry=27-Oct-2026&format=json");
    expect(result).toEqual({
      ok: true,
      value: { symbol: "NIFTY", expiry: "27-Oct-2026", format: "json" },
    });
  });

  it("defaults format to json and expiry to null", () => {
    const result = parse("symbol=nifty");
    expect(result.ok && result.value.symbol).toBe("NIFTY");
    expect(result.ok && result.value.format).toBe("json");
    expect(result.ok && result.value.expiry).toBeNull();
  });

  it("rejects a missing symbol", () => {
    const result = parse("expiry=27-Oct-2026");
    expect(result).toMatchObject({ ok: false, status: 400, code: "missing_symbol" });
  });

  it("rejects an unsafe symbol", () => {
    for (const symbol of ["NIFTY OR 1=1", "'; drop table--", "A".repeat(21)]) {
      const result = parse(`symbol=${encodeURIComponent(symbol)}`);
      expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_symbol" });
    }
  });

  it("rejects impossible or malformed expiries", () => {
    for (const expiry of ["31-Feb-2026", "27 Oct 2026", "27-Oct", "26-13-2026", "1-Jan-1999"]) {
      const result = parse(`symbol=NIFTY&expiry=${encodeURIComponent(expiry)}`);
      expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_expiry" });
    }
  });

  it("rejects unsupported formats", () => {
    const result = parse("symbol=NIFTY&format=xlsx");
    expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_format" });
  });
});

describe("canonicalExpiry", () => {
  it("normalises case and zero padding", () => {
    expect(canonicalExpiry("07-oct-2026")).toBe("7-Oct-2026");
    expect(canonicalExpiry("27-OCT-2026")).toBe("27-Oct-2026");
  });

  it("offers both spellings to the database", () => {
    expect(expiryVariants("7-Oct-2026")).toEqual(["7-Oct-2026", "07-Oct-2026"]);
    expect(expiryVariants("27-Oct-2026")).toEqual(["27-Oct-2026"]);
  });
});
