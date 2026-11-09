import { describe, expect, it } from "vitest";
import {
  PLAYBACK_STEP_MS,
  clampPlaybackIndex,
  initialPlaybackIndex,
  playbackProgress,
  playbackStats,
  restartPlaybackIndex,
  stepPlaybackIndex,
} from "@/lib/session-playback";
import { buildHistorySeries } from "@/lib/history-series";
import { makeHistoryPoint } from "./fixtures";

describe("initialPlaybackIndex", () => {
  it("opens on the newest recorded sample", () => {
    expect(initialPlaybackIndex(4)).toBe(3);
    expect(initialPlaybackIndex(1)).toBe(0);
  });

  it("is null when nothing is recorded", () => {
    expect(initialPlaybackIndex(0)).toBeNull();
    expect(initialPlaybackIndex(-1)).toBeNull();
  });
});

describe("clampPlaybackIndex", () => {
  it("treats a missing index as the newest sample", () => {
    expect(clampPlaybackIndex(null, 5)).toBe(4);
    expect(clampPlaybackIndex(undefined, 5)).toBe(4);
    expect(clampPlaybackIndex(Number.NaN, 5)).toBe(4);
  });

  it("holds values inside the recorded range", () => {
    expect(clampPlaybackIndex(-3, 5)).toBe(0);
    expect(clampPlaybackIndex(99, 5)).toBe(4);
    expect(clampPlaybackIndex(2.9, 5)).toBe(2);
    expect(clampPlaybackIndex(2, 5)).toBe(2);
  });

  it("returns null for an empty series", () => {
    expect(clampPlaybackIndex(0, 0)).toBeNull();
    expect(clampPlaybackIndex(null, -2)).toBeNull();
  });
});

describe("stepPlaybackIndex", () => {
  it("steps one sample at a time", () => {
    expect(stepPlaybackIndex(1, 5, 1)).toBe(2);
    expect(stepPlaybackIndex(1, 5, -1)).toBe(0);
  });

  it("does not wrap past either end of the session", () => {
    expect(stepPlaybackIndex(4, 5, 1)).toBe(4);
    expect(stepPlaybackIndex(0, 5, -1)).toBe(0);
  });

  it("stays null when there is nothing to step through", () => {
    expect(stepPlaybackIndex(0, 0, 1)).toBeNull();
  });
});

describe("restartPlaybackIndex", () => {
  it("restarts from the opening sample", () => {
    expect(restartPlaybackIndex(5)).toBe(0);
    expect(restartPlaybackIndex(1)).toBe(0);
    expect(restartPlaybackIndex(0)).toBeNull();
  });
});

describe("playbackProgress", () => {
  it("maps the range onto 0..1", () => {
    expect(playbackProgress(0, 5)).toBe(0);
    expect(playbackProgress(2, 5)).toBeCloseTo(0.5);
    expect(playbackProgress(4, 5)).toBe(1);
  });

  it("treats a missing cursor as the newest sample", () => {
    expect(playbackProgress(null, 5)).toBe(1);
  });

  it("handles degenerate series without dividing by zero", () => {
    expect(playbackProgress(null, 1)).toBe(1);
    expect(playbackProgress(null, 0)).toBe(0);
    expect(playbackProgress(3, 0)).toBe(0);
  });
});

describe("playbackStats", () => {
  it("reports nothing for a missing sample", () => {
    expect(playbackStats(null)).toEqual({
      time: null,
      spot: null,
      pcr: null,
      maxPain: null,
      ceOi: 0,
      peOi: 0,
      oiDelta: 0,
    });
    expect(playbackStats(undefined)).toEqual(playbackStats(null));
  });

  it("passes the recorded values through and derives the OI balance", () => {
    const [point] = buildHistorySeries([
      makeHistoryPoint({
        spot: 25004.1,
        pcr: 0.9858,
        max_pain: 24950,
        total_ce_oi: 4_890_804,
        total_pe_oi: 4_821_321,
      }),
    ]);
    const stats = playbackStats(point);
    expect(stats.time).toBe("14:50");
    expect(stats.spot).toBe(25004.1);
    expect(stats.pcr).toBe(0.9858);
    expect(stats.maxPain).toBe(24950);
    expect(stats.ceOi).toBe(4_890_804);
    expect(stats.peOi).toBe(4_821_321);
    expect(stats.oiDelta).toBe(4_821_321 - 4_890_804);
  });
});

describe("PLAYBACK_STEP_MS", () => {
  it("is a sane auto-play cadence", () => {
    expect(PLAYBACK_STEP_MS).toBeGreaterThanOrEqual(200);
    expect(PLAYBACK_STEP_MS).toBeLessThanOrEqual(5_000);
  });
});
