/**
 * Index math and read-outs for the session playback scrubber.
 *
 * The scrubber walks the stored intraday series point by point; it never
 * invents data, it only selects which already-recorded sample is displayed.
 * All functions are pure so the behaviour at the ends of the range is unit
 * tested rather than discovered while dragging the slider.
 */
import type { HistorySeriesPoint } from "./history-series";

/** Auto-play cadence: one recorded sample per tick. */
export const PLAYBACK_STEP_MS = 900;

/** Default position is the newest sample (the end of the recorded session). */
export function initialPlaybackIndex(length: number): number | null {
  return Number.isFinite(length) && length > 0 ? Math.trunc(length) - 1 : null;
}

/**
 * Keep an index inside [0, length-1]. A missing index means "newest sample",
 * an empty series means "nothing to show" (null).
 */
export function clampPlaybackIndex(
  index: number | null | undefined,
  length: number,
): number | null {
  if (!Number.isFinite(length) || length <= 0) return null;
  const last = Math.trunc(length) - 1;
  if (index === null || index === undefined || !Number.isFinite(index)) return last;
  const truncated = Math.trunc(index);
  if (truncated < 0) return 0;
  return truncated > last ? last : truncated;
}

/** Move by `direction` (+1/-1) without wrapping: the ends hold their position. */
export function stepPlaybackIndex(
  index: number | null | undefined,
  length: number,
  direction: 1 | -1,
): number | null {
  const current = clampPlaybackIndex(index, length);
  if (current === null) return null;
  return clampPlaybackIndex(current + direction, length);
}

/** Play pressed at the end of the session restarts from the opening sample. */
export function restartPlaybackIndex(length: number): number | null {
  return Number.isFinite(length) && length > 0 ? 0 : null;
}

/** 0..1 position of the cursor; 0 when there is nothing recorded. */
export function playbackProgress(index: number | null | undefined, length: number): number {
  if (!Number.isFinite(length) || length <= 1) return length > 0 ? 1 : 0;
  const clamped = clampPlaybackIndex(index, length);
  if (clamped === null) return 0;
  return clamped / (Math.trunc(length) - 1);
}

export interface PlaybackStats {
  time: string | null;
  spot: number | null;
  pcr: number | null;
  maxPain: number | null;
  ceOi: number;
  peOi: number;
  /** PE OI minus CE OI at this sample; positive means more put-side writing. */
  oiDelta: number;
}

export function playbackStats(
  point: HistorySeriesPoint | null | undefined,
): PlaybackStats {
  if (!point) {
    return { time: null, spot: null, pcr: null, maxPain: null, ceOi: 0, peOi: 0, oiDelta: 0 };
  }
  return {
    time: point.time,
    spot: point.spot,
    pcr: point.pcr,
    maxPain: point.maxPain,
    ceOi: point.ceOi,
    peOi: point.peOi,
    oiDelta: point.peOi - point.ceOi,
  };
}
