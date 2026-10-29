import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_LIMIT,
  canonicalExpiry,
  expiryVariants,
  parseHistoryQuery,
  parseOptionChainQuery,
  parseSymbolQuery,
} from "@/lib/api-validation";
import { ALL_FIELD_GROUPS, DEFAULT_FIELD_GROUPS } from "@/lib/chain-selection";

const parse = (query: string) => parseOptionChainQuery(new URLSearchParams(query));

describe("parseOptionChainQuery", () => {
  it("accepts the documented query and defaults to the complete chain", () => {
    const result = parse("symbol=NIFTY&expiry=27-Oct-2026&format=json");
    expect(result).toEqual({
      ok: true,
      value: {
        symbol: "NIFTY",
        expiry: "27-Oct-2026",
        format: "json",
        range: "all",
        fields: ALL_FIELD_GROUPS,
      },
    });
  });

  it("defaults format to json and expiry to null", () => {
    const result = parse("symbol=nifty");
    expect(result.ok && result.value.symbol).toBe("NIFTY");
    expect(result.ok && result.value.format).toBe("json");
    expect(result.ok && result.value.expiry).toBeNull();
  });

  it("accepts documented strike ranges", () => {
    for (const range of ["all", "10", "20", "30"]) {
      const result = parse(`symbol=NIFTY&range=${range}`);
      expect(result.ok && result.value.range).toBe(range);
    }
  });

  it("rejects an unknown strike range", () => {
    const result = parse("symbol=NIFTY&range=50");
    expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_range" });
  });

  it("parses and de-duplicates selected field groups", () => {
    const result = parse("symbol=NIFTY&fields=oi,iv,oi,ltp");
    expect(result.ok && result.value.fields).toEqual(["oi", "iv", "ltp"]);
  });

  it("rejects unknown field groups", () => {
    const result = parse("symbol=NIFTY&fields=oi,secret");
    expect(result).toMatchObject({ ok: false, status: 400, code: "invalid_fields" });
  });

  it("treats an empty field list as the default six groups", () => {
    for (const query of ["symbol=NIFTY&fields=", "symbol=NIFTY&fields=,,"]) {
      const result = parse(query);
      expect(result.ok && result.value.fields).toEqual(ALL_FIELD_GROUPS);
    }
  });

  it("exposes the default UI groups separately from all groups", () => {
    expect(DEFAULT_FIELD_GROUPS).toEqual([
      "oi",
      "oi_change",
      "volume",
      "iv",
      "ltp",
      "price_change",
    ]);
    expect(ALL_FIELD_GROUPS).toContain("bid_ask");
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

describe("parseSymbolQuery", () => {
  it("requires a symbol", () => {
    expect(parseSymbolQuery(new URLSearchParams(""))).toMatchObject({
      ok: false,
      status: 400,
      code: "missing_symbol",
    });
  });

  it("upper-cases the symbol", () => {
    const result = parseSymbolQuery(new URLSearchParams("symbol=banknifty"));
    expect(result.ok && result.value.symbol).toBe("BANKNIFTY");
  });
});

describe("parseHistoryQuery", () => {
  const parseHistory = (query: string) => parseHistoryQuery(new URLSearchParams(query));

  it("defaults the limit and accepts an explicit one", () => {
    const fallback = parseHistory("symbol=NIFTY&expiry=27-Oct-2026");
    expect(fallback.ok && fallback.value.limit).toBe(60);
    const explicit = parseHistory("symbol=NIFTY&expiry=27-Oct-2026&limit=120");
    expect(explicit.ok && explicit.value.limit).toBe(120);
  });

  it("requires an expiry", () => {
    expect(parseHistory("symbol=NIFTY")).toMatchObject({
      ok: false,
      status: 400,
      code: "missing_expiry",
    });
  });

  it("rejects out-of-range or non-integer limits", () => {
    for (const limit of ["0", "12.5", "abc", String(MAX_HISTORY_LIMIT + 1)]) {
      expect(parseHistory(`symbol=NIFTY&expiry=27-Oct-2026&limit=${limit}`)).toMatchObject({
        ok: false,
        status: 400,
        code: "invalid_limit",
      });
    }
  });

  it("rejects unknown query parameters instead of silently ignoring them", () => {
    // Regression: `points` used to be swallowed, which read as if it worked.
    expect(parseHistory("symbol=NIFTY&expiry=27-Oct-2026&points=5")).toMatchObject({
      ok: false,
      status: 400,
      code: "unknown_parameter",
    });
  });

  it("names the offending parameter and the allowed keys", () => {
    const result = parseHistory("symbol=NIFTY&expiry=27-Oct-2026&points=5");
    expect(result.ok === false && result.message).toContain("points");
    expect(result.ok === false && result.message).toContain("limit");
  });
});

describe("unknown query parameters", () => {
  it("rejects extra keys on the option-chain route", () => {
    expect(parse("symbol=NIFTY&bogus=1")).toMatchObject({
      ok: false,
      status: 400,
      code: "unknown_parameter",
    });
  });

  it("rejects extra keys on the expiries route", () => {
    expect(parseSymbolQuery(new URLSearchParams("symbol=NIFTY&format=csv"))).toMatchObject({
      ok: false,
      status: 400,
      code: "unknown_parameter",
    });
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
