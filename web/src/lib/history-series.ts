/**
 * Normalises stored intraday history into the shape the charts and the
 * session playback scrubber consume.
 *
 * History rows arrive oldest-first from the API, but this module never relies
 * on that: points are ordered by their actual capture time and rows without a
 * readable timestamp are dropped rather than plotted at a made-up position.
 */
import type { OptionChainHistoryPoint } from "@/types/option-chain";
import { parseNseTimestamp } from "./market-status";

export interface HistorySeriesPoint {
  id: number;
  /**
   * Unique axis key (`${captureMs}-${id}`): two samples can share a minute, so
   * the clock label alone cannot identify a point on the chart.
   */
  key: string;
  /** Short IST clock label used for display, e.g. "14:50". */
  time: string;
  /** Milliseconds since epoch for ordering; null when the row is unusable. */
  at: number;
  spot: number | null;
  pcr: number | null;
  maxPain: number | null;
  ceOi: number;
  peOi: number;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function captureDate(point: OptionChainHistoryPoint): Date | null {
  const fromSource = parseNseTimestamp(point.nse_timestamp);
  if (fromSource) return fromSource;
  const createdMs = point.created_at ? Date.parse(point.created_at) : NaN;
  return Number.isFinite(createdMs) ? new Date(createdMs) : null;
}

const IST_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Build the chart series: readable rows only, sorted oldest to newest.
 * A point missing its spot or aggregates still plots — only a missing capture
 * time disqualifies it, because that is what positions it on the axis.
 */
export function buildHistorySeries(
  points: readonly OptionChainHistoryPoint[],
): HistorySeriesPoint[] {
  const usable: HistorySeriesPoint[] = [];

  for (const point of points) {
    const captured = captureDate(point);
    if (!captured) continue;
    const at = captured.getTime();
    usable.push({
      id: point.id,
      key: `${at}-${point.id}`,
      time: IST_CLOCK.format(captured),
      at,
      spot: finiteOrNull(point.spot),
      pcr: finiteOrNull(point.pcr),
      maxPain: finiteOrNull(point.max_pain),
      ceOi: finiteOrNull(point.total_ce_oi) ?? 0,
      peOi: finiteOrNull(point.total_pe_oi) ?? 0,
    });
  }

  usable.sort((a, b) => (a.at === b.at ? a.id - b.id : a.at - b.at));
  return usable;
}

/**
 * Recover the clock label from an axis key, so a chart can key its X axis by
 * `HistorySeriesPoint.key` (unique) while still ticking "14:50".
 * Unparseable keys fall back to the raw value rather than throwing.
 */
export function seriesKeyToTime(key: string): string {
  const captureMs = Number.parseInt(key.split("-")[0] ?? "", 10);
  if (!Number.isFinite(captureMs)) return key;
  return IST_CLOCK.format(new Date(captureMs));
}
