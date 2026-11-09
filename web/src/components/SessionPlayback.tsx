"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from "lucide-react";
import type { HistorySeriesPoint } from "@/lib/history-series";
import {
  PLAYBACK_STEP_MS,
  clampPlaybackIndex,
  playbackProgress,
  playbackStats,
  restartPlaybackIndex,
  stepPlaybackIndex,
} from "@/lib/session-playback";
import { formatIndian } from "@/lib/supabase";

interface SessionPlaybackProps {
  /** Recorded intraday samples, oldest first (see buildHistorySeries). */
  series: HistorySeriesPoint[];
  /** Index of the sample being shown; null means "the newest sample". */
  activeIndex: number | null;
  onChange: (index: number | null) => void;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-zinc-100">{value}</div>
    </div>
  );
}

/**
 * Scrub through the samples the collector already recorded for this session.
 * Nothing is fetched or interpolated: moving the slider only selects which
 * stored point the charts and the read-out display.
 */
export function SessionPlayback({ series, activeIndex, onChange }: SessionPlaybackProps) {
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<number | null>(null);

  const length = series.length;
  const index = clampPlaybackIndex(activeIndex, length);
  const point = index === null ? null : (series[index] ?? null);
  const stats = playbackStats(point);
  const progress = playbackProgress(index, length);

  // Auto-play: advance one recorded sample per tick. The tick that would step
  // past the last recorded sample stops playback instead of wrapping around.
  useEffect(() => {
    if (!playing || index === null) return;
    const isLast = index >= length - 1;
    timerRef.current = window.setTimeout(() => {
      if (isLast) {
        setPlaying(false);
        return;
      }
      onChange(stepPlaybackIndex(index, length, 1));
    }, PLAYBACK_STEP_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [playing, index, length, onChange]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  if (length === 0) return null;

  const atStart = index === 0;
  const atEnd = index === length - 1;

  const handlePlayPause = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Pressing play on the last sample rewinds first, so the session replays.
    if (atEnd) onChange(restartPlaybackIndex(length));
    setPlaying(true);
  };

  return (
    <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-zinc-100">Session Playback</h3>
          <p className="text-xs text-zinc-400">
            {length} recorded sample{length === 1 ? "" : "s"} · drag to replay the session;
            every value shown was stored by the collector.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onChange(stepPlaybackIndex(index, length, -1))}
            disabled={atStart}
            aria-label="Previous sample"
            className="rounded-md border border-zinc-800 bg-zinc-950 p-1.5 text-zinc-300 transition-colors hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handlePlayPause}
            aria-label={playing ? "Pause playback" : "Play session"}
            className="flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/20"
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {playing ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              onChange(stepPlaybackIndex(index, length, 1));
            }}
            disabled={atEnd}
            aria-label="Next sample"
            className="rounded-md border border-zinc-800 bg-zinc-950 p-1.5 text-zinc-300 transition-colors hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setPlaying(false);
              onChange(null);
            }}
            disabled={atEnd && !playing}
            aria-label="Jump to the newest sample"
            title="Jump to the newest sample"
            className="rounded-md border border-zinc-800 bg-zinc-950 p-1.5 text-zinc-300 transition-colors hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        </div>
      </div>

      <input
        type="range"
        min={0}
        max={Math.max(0, length - 1)}
        step={1}
        value={index ?? length - 1}
        onChange={(event) => {
          setPlaying(false);
          onChange(Number(event.target.value));
        }}
        aria-label="Session position"
        className="mt-3 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-zinc-800 accent-emerald-500"
      />

      <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
        <span>{series[0]?.time ?? ""}</span>
        <span className="font-semibold text-emerald-400">
          {Math.round(progress * 100)}% · sample {(index ?? 0) + 1} of {length}
        </span>
        <span>{series[length - 1]?.time ?? ""}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Time (IST)" value={stats.time ?? "—"} />
        <StatTile label="Spot" value={stats.spot !== null ? formatIndian(stats.spot, 2) : "—"} />
        <StatTile label="PCR (OI)" value={stats.pcr !== null ? stats.pcr.toFixed(3) : "—"} />
        <StatTile label="Max Pain" value={stats.maxPain !== null ? formatIndian(stats.maxPain) : "—"} />
        <StatTile label="Total CE OI" value={formatIndian(stats.ceOi)} />
        <StatTile label="Total PE OI" value={formatIndian(stats.peOi)} />
      </div>
    </div>
  );
}
