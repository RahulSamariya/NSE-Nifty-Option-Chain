import { describe, expect, it } from "vitest";
import { computeMaxPain, summarizeChain } from "@/lib/chain-analytics";
import { makeStrike } from "./fixtures";

describe("summarizeChain", () => {
  it("totals CE and PE open interest and returns the ratio", () => {
    const rows = [
      makeStrike(26400, { CE_OI: 1000, PE_OI: 2000 }),
      makeStrike(26500, { CE_OI: 3000, PE_OI: 1000 }),
    ];
    const summary = summarizeChain(rows);
    expect(summary.totalCeOi).toBe(4000);
    expect(summary.totalPeOi).toBe(3000);
    expect(summary.pcr).toBeCloseTo(0.75, 10);
  });

  it("returns a null PCR when there is no call-side OI", () => {
    const summary = summarizeChain([makeStrike(26400, { CE_OI: 0, PE_OI: 5000 })]);
    expect(summary.pcr).toBeNull();
  });

  it("finds the strikes carrying the largest OI on each side", () => {
    const rows = [
      makeStrike(26400, { CE_OI: 1000, PE_OI: 500 }),
      makeStrike(26500, { CE_OI: 9000, PE_OI: 800 }),
      makeStrike(26600, { CE_OI: 2000, PE_OI: 7000 }),
    ];
    const summary = summarizeChain(rows);
    expect(summary.maxCeStrike).toBe(26500);
    expect(summary.maxPeStrike).toBe(26600);
  });

  it("treats missing OI as zero rather than NaN", () => {
    const rows = [makeStrike(26400, { CE_OI: undefined, PE_OI: undefined })];
    const summary = summarizeChain(rows);
    expect(summary.totalCeOi).toBe(0);
    expect(summary.totalPeOi).toBe(0);
    expect(summary.maxCeStrike).toBeNull();
  });
});

describe("computeMaxPain", () => {
  it("returns null for an empty chain", () => {
    expect(computeMaxPain([])).toBeNull();
  });

  it("matches the textbook single-call worked example", () => {
    // One call of OI 1 at strike 100: buyers lose the most if the market
    // settles at the highest strike, where the intrinsic value is greatest.
    const rows = [makeStrike(100, { CE_OI: 1, PE_OI: 0 })];
    expect(computeMaxPain(rows)).toBe(100);
  });

  it("reproduces the Python max_pain result for a symmetric chain", () => {
    // Symmetric OI around 26500 pins the pain minimum at the centre strike.
    const rows = [
      makeStrike(26300, { CE_OI: 0, PE_OI: 50000 }),
      makeStrike(26400, { CE_OI: 0, PE_OI: 30000 }),
      makeStrike(26500, { CE_OI: 20000, PE_OI: 20000 }),
      makeStrike(26600, { CE_OI: 30000, PE_OI: 0 }),
      makeStrike(26700, { CE_OI: 50000, PE_OI: 0 }),
    ];
    expect(computeMaxPain(rows)).toBe(26500);
  });

  it("centres max pain on the symmetric hub strike", () => {
    // Same mirrored OI shape as above but centred on 26600: heavy call OI
    // above and heavy put OI below pull the pain minimum to the hub.
    const rows = [
      makeStrike(26400, { CE_OI: 0, PE_OI: 50000 }),
      makeStrike(26500, { CE_OI: 0, PE_OI: 30000 }),
      makeStrike(26600, { CE_OI: 20000, PE_OI: 20000 }),
      makeStrike(26700, { CE_OI: 30000, PE_OI: 0 }),
      makeStrike(26800, { CE_OI: 50000, PE_OI: 0 }),
    ];
    expect(computeMaxPain(rows)).toBe(26600);
  });

  it("always returns a strike that exists in the chain", () => {
    const rows = [
      makeStrike(26000, { CE_OI: 1200, PE_OI: 400 }),
      makeStrike(26100, { CE_OI: 800, PE_OI: 900 }),
      makeStrike(26200, { CE_OI: 1500, PE_OI: 600 }),
    ];
    expect(rows.map((r) => r.STRIKE)).toContain(computeMaxPain(rows));
  });
});
