import { describe, expect, it } from "vitest";
import { buildHistorySeries, seriesKeyToTime } from "@/lib/history-series";
import { makeHistoryPoint } from "./fixtures";

describe("buildHistorySeries", () => {
  it("returns an empty series for no history", () => {
    expect(buildHistorySeries([])).toEqual([]);
  });

  it("orders rows by capture time, not by how the API returned them", () => {
    const late = makeHistoryPoint({
      id: 3,
      nse_timestamp: "09-Nov-2026 14:55:00",
      created_at: "2026-11-09T09:25:00Z",
    });
    const early = makeHistoryPoint({
      id: 1,
      nse_timestamp: "09-Nov-2026 14:50:00",
      created_at: "2026-11-09T09:20:00Z",
    });
    const middle = makeHistoryPoint({
      id: 2,
      nse_timestamp: "09-Nov-2026 14:52:30",
      created_at: "2026-11-09T09:22:30Z",
    });

    const series = buildHistorySeries([late, early, middle]);
    expect(series.map((point) => point.id)).toEqual([1, 2, 3]);
    expect(series.map((point) => point.at)).toEqual([
      Date.parse("2026-11-09T09:20:00Z"),
      Date.parse("2026-11-09T09:22:30Z"),
      Date.parse("2026-11-09T09:25:00Z"),
    ]);
  });

  it("breaks identical timestamps by id so the order stays deterministic", () => {
    const first = makeHistoryPoint({ id: 7, nse_timestamp: "09-Nov-2026 14:50:00" });
    const second = makeHistoryPoint({ id: 8, nse_timestamp: "09-Nov-2026 14:50:00" });
    expect(buildHistorySeries([second, first]).map((point) => point.id)).toEqual([7, 8]);
  });

  it("labels each point with its IST clock time", () => {
    const [point] = buildHistorySeries([
      makeHistoryPoint({ nse_timestamp: "09-Nov-2026 14:50:58" }),
    ]);
    expect(point.time).toBe("14:50");
  });

  it("falls back to created_at when the NSE timestamp is unusable", () => {
    const [point] = buildHistorySeries([
      makeHistoryPoint({ nse_timestamp: null, created_at: "2026-11-09T09:20:04Z" }),
    ]);
    // 09:20 UTC is 14:50 IST.
    expect(point.time).toBe("14:50");
    expect(point.at).toBe(Date.parse("2026-11-09T09:20:04Z"));
  });

  it("drops rows that have no readable capture time instead of guessing one", () => {
    const usable = makeHistoryPoint({ id: 1 });
    const broken = makeHistoryPoint({
      id: 2,
      nse_timestamp: "not-a-timestamp",
      created_at: "also-not-a-timestamp",
    });
    expect(buildHistorySeries([broken, usable]).map((point) => point.id)).toEqual([1]);
  });

  it("keeps rows with missing metrics but never turns them into numbers", () => {
    const [point] = buildHistorySeries([
      makeHistoryPoint({ pcr: null, max_pain: null, spot: 25010.5 }),
    ]);
    expect(point.pcr).toBeNull();
    expect(point.maxPain).toBeNull();
    expect(point.spot).toBe(25010.5);
  });

  it("defaults missing open interest totals to zero rather than NaN", () => {
    const [point] = buildHistorySeries([
      makeHistoryPoint({
        total_ce_oi: Number.NaN,
        total_pe_oi: null as unknown as number,
      }),
    ]);
    expect(point.ceOi).toBe(0);
    expect(point.peOi).toBe(0);
  });

  it("gives every point a unique axis key, even within the same minute", () => {
    const series = buildHistorySeries([
      makeHistoryPoint({ id: 1, nse_timestamp: "09-Nov-2026 14:50:00" }),
      makeHistoryPoint({ id: 2, nse_timestamp: "09-Nov-2026 14:50:00" }),
    ]);
    expect(series.map((point) => point.time)).toEqual(["14:50", "14:50"]);
    expect(new Set(series.map((point) => point.key)).size).toBe(2);
  });
});

describe("seriesKeyToTime", () => {
  it("recovers the clock label from an axis key", () => {
    const [point] = buildHistorySeries([
      makeHistoryPoint({ nse_timestamp: "09-Nov-2026 14:50:58" }),
    ]);
    expect(seriesKeyToTime(point.key)).toBe("14:50");
  });

  it("passes through keys that carry no capture time", () => {
    expect(seriesKeyToTime("bogus-key")).toBe("bogus-key");
    expect(seriesKeyToTime("")).toBe("");
  });
});
