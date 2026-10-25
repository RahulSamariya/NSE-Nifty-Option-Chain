import { describe, expect, it } from "vitest";
import {
  ALL_FIELD_GROUPS,
  DEFAULT_FIELD_GROUPS,
  FIELD_GROUPS,
  parseFieldGroups,
  parseStrikeRange,
  pickFields,
  rangeLabel,
  selectChainFields,
  selectStrikes,
  strikeRadius,
} from "@/lib/chain-selection";
import { makeStrike } from "./fixtures";

const strikes = [19000, 19500, 20000, 20500, 21000, 21500, 22000];
const rows = strikes.map((strike) => makeStrike(strike));

describe("strike ranges", () => {
  it("maps documented values to radii", () => {
    expect(strikeRadius("all")).toBe(0);
    expect(strikeRadius("10")).toBe(10);
    expect(parseStrikeRange("20")).toBe("20");
    expect(parseStrikeRange("ALL")).toBe("all");
    expect(parseStrikeRange("0")).toBe("all");
    expect(parseStrikeRange("")).toBe("all");
    expect(parseStrikeRange("7")).toBeNull();
  });

  it("labels ranges for the workbook summary", () => {
    expect(rangeLabel("all")).toBe("All strikes");
    expect(rangeLabel("10")).toBe("ATM +/- 10 strikes");
  });

  it("returns every strike for the all range", () => {
    expect(selectStrikes(rows, 20400, "all")).toHaveLength(rows.length);
  });

  it("centres the window on the strike closest to spot", () => {
    const window = selectStrikes(rows, 20520, "10");
    // radius 10 on a 7-strike chain clamps to the whole chain
    expect(window.map((row) => row.STRIKE)).toEqual(strikes);
  });

  it("keeps 2 * radius + 1 strikes in the middle of a long chain", () => {
    const wide = Array.from({ length: 61 }, (_, index) => makeStrike(20000 + index * 50));
    const window = selectStrikes(wide, 21310, "10");
    expect(window).toHaveLength(21);
    // ATM is 21300, so 10 strikes either side
    expect(window[0].STRIKE).toBe(21300 - 500);
    expect(window.at(-1)?.STRIKE).toBe(21300 + 500);
  });

  it("clamps at the start and end of the chain", () => {
    const wide = Array.from({ length: 61 }, (_, index) => makeStrike(20000 + index * 50));
    const low = selectStrikes(wide, 19500, "10");
    expect(low[0].STRIKE).toBe(20000);
    expect(low).toHaveLength(11);

    const high = selectStrikes(wide, 24000, "10");
    expect(high.at(-1)?.STRIKE).toBe(23000);
    expect(high).toHaveLength(11);
  });

  it("sorts unordered rows before windowing", () => {
    const shuffled = [makeStrike(20500), makeStrike(19500), makeStrike(20000)];
    expect(selectStrikes(shuffled, 20000, "10").map((row) => row.STRIKE)).toEqual([
      19500, 20000, 20500,
    ]);
  });
});

describe("field groups", () => {
  it("keeps the default export at the six documented groups", () => {
    expect(DEFAULT_FIELD_GROUPS).toEqual(
      FIELD_GROUPS.filter((group) => group.required).map((group) => group.value),
    );
    expect(DEFAULT_FIELD_GROUPS).not.toContain("bid_ask");
  });

  it("defaults a missing or empty parameter to the complete schema", () => {
    expect(parseFieldGroups(null)).toEqual(ALL_FIELD_GROUPS);
    expect(parseFieldGroups("")).toEqual(ALL_FIELD_GROUPS);
    expect(parseFieldGroups("all")).toEqual(ALL_FIELD_GROUPS);
  });

  it("returns null for unknown groups", () => {
    expect(parseFieldGroups("oi,gamma")).toBeNull();
  });

  it("selects only the columns of the chosen groups", () => {
    const fields = selectChainFields(["oi"]).map((field) => field.key);
    expect(fields).toEqual(["STRIKE", "CE_OI", "PE_OI"]);
  });

  it("includes change-in-OI, volume, IV, LTP and price change groups", () => {
    const keys = selectChainFields(DEFAULT_FIELD_GROUPS).map((field) => field.key);
    expect(keys).toContain("CE_OI");
    expect(keys).toContain("CE_CHNG_IN_OI");
    expect(keys).toContain("CE_VOLUME");
    expect(keys).toContain("CE_IV");
    expect(keys).toContain("CE_LTP");
    expect(keys).toContain("CE_CHNG");
    expect(keys).not.toContain("CE_BID");
  });

  it("adds bid/ask only when requested", () => {
    const keys = selectChainFields(ALL_FIELD_GROUPS).map((field) => field.key);
    expect(keys).toContain("CE_BID");
    expect(keys).toContain("PE_ASK_QTY");
  });

  it("always keeps the strike column, even with no groups", () => {
    expect(selectChainFields([]).map((field) => field.key)).toEqual(["STRIKE"]);
  });

  it("projects rows onto the selected columns without inventing values", () => {
    const fields = selectChainFields(["ltp"]);
    const projected = pickFields(rows[0] as unknown as Record<string, unknown>, fields);
    expect(projected).toEqual({ STRIKE: 19000, CE_LTP: 101.5, PE_LTP: 88.25 });
    const missing = pickFields({ STRIKE: 1 }, fields);
    expect(missing.CE_LTP).toBeNull();
  });
});
