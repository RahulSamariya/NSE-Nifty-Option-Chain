import { describe, expect, it } from "vitest";
import {
  isOptionChainRecord,
  normalizeOptionChainRecord,
  toFiniteNumber,
} from "@/lib/option-chain-record";
import { makeRecord } from "./fixtures";

describe("toFiniteNumber", () => {
  it("accepts PostgREST numerics in both shapes", () => {
    expect(toFiniteNumber(12)).toBe(12);
    expect(toFiniteNumber("12.5")).toBe(12.5);
  });

  it("rejects everything that is not a real number", () => {
    for (const value of [null, undefined, "", "  ", "abc", NaN, Infinity, {}]) {
      expect(toFiniteNumber(value)).toBeNull();
    }
  });
});

describe("isOptionChainRecord", () => {
  it("accepts a complete snapshot", () => {
    expect(isOptionChainRecord(makeRecord())).toBe(true);
  });

  it("rejects placeholders and partial rows", () => {
    const base = makeRecord();
    expect(isOptionChainRecord({ ...base, spot: 0 })).toBe(false);
    expect(isOptionChainRecord({ ...base, raw_data: [] })).toBe(false);
    expect(isOptionChainRecord({ ...base, raw_data: [{ STRIKE: null }] })).toBe(false);
    expect(isOptionChainRecord({ ...base, expiry: "" })).toBe(false);
    expect(isOptionChainRecord(null)).toBe(false);
  });

  it("checks the requested symbol when given", () => {
    expect(isOptionChainRecord(makeRecord(), "NIFTY")).toBe(true);
    expect(isOptionChainRecord(makeRecord(), "BANKNIFTY")).toBe(false);
  });
});

describe("normalizeOptionChainRecord", () => {
  it("coerces numeric strings and sorts strikes", () => {
    const record = normalizeOptionChainRecord({
      ...makeRecord(),
      spot: "22600",
      pcr: "0.73",
      max_pain: "22700",
      raw_data: [
        { STRIKE: "20050", CE_OI: "12" },
        { STRIKE: "19950", PE_OI: "13" },
      ],
    });
    expect(record).not.toBeNull();
    expect(record?.spot).toBe(22600);
    expect(record?.pcr).toBe(0.73);
    expect(record?.raw_data.map((row) => row.STRIKE)).toEqual([19950, 20050]);
    expect(record?.raw_data[1].CE_OI).toBe("12");
  });

  it("returns null for unusable rows rather than inventing a snapshot", () => {
    expect(normalizeOptionChainRecord({ raw_data: [] })).toBeNull();
  });
});
