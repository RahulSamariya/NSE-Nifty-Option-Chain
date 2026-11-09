"use client";

import React, { useMemo } from "react";
import { StrikeRow } from "@/types/option-chain";
import type { HistorySeriesPoint } from "@/lib/history-series";
import { seriesKeyToTime } from "@/lib/history-series";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
} from "recharts";
import { formatIndian } from "@/lib/supabase";

interface ChartsViewProps {
  rows: StrikeRow[];
  spot: number | null;
  /** Recorded intraday samples, oldest first; empty when history is unavailable. */
  series?: HistorySeriesPoint[];
  /** Index of the sample the session playback scrubber is showing. */
  playbackIndex?: number | null;
}

const TOOLTIP_STYLE = {
  backgroundColor: "#09090b",
  borderColor: "#27272a",
  borderRadius: "8px",
  fontSize: "12px",
} as const;

export function ChartsView({
  rows,
  spot,
  series = [],
  playbackIndex = null,
}: ChartsViewProps) {
  // Format rows for Recharts
  const chartData = useMemo(() => {
    if (!rows || rows.length === 0) return [];
    // Sort by strike ascending
    return [...rows]
      .sort((a, b) => a.STRIKE - b.STRIKE)
      .map((r) => ({
        strike: r.STRIKE,
        callOi: r.CE_OI ?? 0,
        putOi: r.PE_OI ?? 0,
        callChngOi: r.CE_CHNG_IN_OI ?? 0,
        putChngOi: r.PE_CHNG_IN_OI ?? 0,
        callIv: r.CE_IV && r.CE_IV > 0 ? r.CE_IV : null,
        putIv: r.PE_IV && r.PE_IV > 0 ? r.PE_IV : null,
        callLtp: r.CE_LTP ?? 0,
        putLtp: r.PE_LTP ?? 0,
      }));
  }, [rows]);

  /** Sample the playback scrubber is pinned to; null when it is not active. */
  const activeSample =
    playbackIndex === null || playbackIndex === undefined
      ? null
      : (series[Math.min(Math.max(playbackIndex, 0), series.length - 1)] ?? null);

  return (
    <div className="space-y-6 my-4">
      {/* Chart 1: Open Interest Distribution */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 shadow-lg">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-bold text-zinc-100">
              Open Interest (OI) by Strike
            </h3>
            <p className="text-xs text-zinc-400">
              Comparing Call (Resistance) vs Put (Support) OI across strikes
            </p>
          </div>
          <div className="text-xs px-2 py-1 rounded bg-zinc-800 text-zinc-300">
            Spot: <span className="font-bold text-emerald-400">{spot !== null && spot > 0 ? formatIndian(spot, 2) : "Unavailable"}</span>
          </div>
        </div>

        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="strike" stroke="#71717a" fontSize={11} />
              <YAxis
                stroke="#71717a"
                fontSize={11}
                tickFormatter={(v) => formatIndian(v)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#09090b",
                  borderColor: "#27272a",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
                formatter={(val) => [formatIndian(val as number), ""]}
              />
              <Legend wrapperStyle={{ fontSize: "12px", paddingTop: "8px" }} />
              {spot !== null && spot > 0 && (
                <ReferenceLine
                  x={Math.round(spot / 50) * 50}
                  stroke="#38bdf8"
                  strokeDasharray="4 4"
                  label={{ value: `Spot: ${spot}`, fill: "#38bdf8", fontSize: 11 }}
                />
              )}
              <Bar dataKey="callOi" name="Call (CE) OI" fill="#f43f5e" radius={[4, 4, 0, 0]} />
              <Bar dataKey="putOi" name="Put (PE) OI" fill="#10b981" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Grid: Change in OI & IV Smile */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Chart 2: Change in OI */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 shadow-lg">
          <h3 className="text-sm font-bold text-zinc-100 mb-1">
            Change in Open Interest (Intraday Shift)
          </h3>
          <p className="text-xs text-zinc-400 mb-3">
            Positive = Writing / Buildup, Negative = Unwinding
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="strike" stroke="#71717a" fontSize={11} />
                <YAxis
                  stroke="#71717a"
                  fontSize={11}
                  tickFormatter={(v) => formatIndian(v)}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#09090b",
                    borderColor: "#27272a",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(val) => [formatIndian(val as number), ""]}
                />
                <Legend wrapperStyle={{ fontSize: "12px" }} />
                <Bar dataKey="callChngOi" name="Call Chng OI" fill="#f43f5e" />
                <Bar dataKey="putChngOi" name="Put Chng OI" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 3: Implied Volatility (IV Smile) */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 shadow-lg">
          <h3 className="text-sm font-bold text-zinc-100 mb-1">
            Implied Volatility (IV Smile Curve)
          </h3>
          <p className="text-xs text-zinc-400 mb-3">
            Volatility skew indicating pricing and market expectations
          </p>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="strike" stroke="#71717a" fontSize={11} />
                <YAxis stroke="#71717a" fontSize={11} domain={["auto", "auto"]} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#09090b",
                    borderColor: "#27272a",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(val) => [`${val}%`, ""]}
                />
                <Legend wrapperStyle={{ fontSize: "12px" }} />
                <Line
                  type="monotone"
                  dataKey="callIv"
                  name="Call IV (%)"
                  stroke="#f43f5e"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  connectNulls
                />
                <Line
                  type="monotone"
                  dataKey="putIv"
                  name="Put IV (%)"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Intraday block: every sample below was recorded by the collector. */}
      {series.length > 0 && (
        <>
          {/* Chart 4: Historical Intraday Timeline (Spot vs PCR) */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 shadow-lg">
            <h3 className="text-sm font-bold text-zinc-100 mb-1">
              Intraday Spot vs. PCR Timeline
            </h3>
            <p className="text-xs text-zinc-400 mb-3">
              Correlating price action with sentiment shifts throughout the trading day
            </p>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis
                    dataKey="key"
                    tickFormatter={seriesKeyToTime}
                    interval="preserveStartEnd"
                    minTickGap={40}
                    stroke="#71717a"
                    fontSize={11}
                  />
                  <YAxis yAxisId="spot" stroke="#38bdf8" fontSize={11} domain={["auto", "auto"]} />
                  <YAxis
                    yAxisId="pcr"
                    orientation="right"
                    stroke="#fbbf24"
                    fontSize={11}
                    domain={["auto", "auto"]}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(label) => seriesKeyToTime(String(label))}
                  />
                  <Legend wrapperStyle={{ fontSize: "12px" }} />
                  {activeSample && (
                    <ReferenceLine
                      yAxisId="spot"
                      x={activeSample.key}
                      stroke="#a855f7"
                      strokeDasharray="4 4"
                      label={{ value: activeSample.time, fill: "#a855f7", fontSize: 10 }}
                    />
                  )}
                  <Line
                    yAxisId="spot"
                    type="monotone"
                    dataKey="spot"
                    name="Spot Price"
                    stroke="#38bdf8"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    yAxisId="pcr"
                    type="monotone"
                    dataKey="pcr"
                    name="PCR (OI)"
                    stroke="#fbbf24"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Grid: Max Pain drift & total open interest build-up */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Chart 5: Max Pain vs Spot */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 shadow-lg">
              <h3 className="text-sm font-bold text-zinc-100 mb-1">
                Max Pain vs. Spot
              </h3>
              <p className="text-xs text-zinc-400 mb-3">
                Where expiry pain settles as price drifts through the session
              </p>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis
                      dataKey="key"
                      tickFormatter={seriesKeyToTime}
                      interval="preserveStartEnd"
                      minTickGap={40}
                      stroke="#71717a"
                      fontSize={11}
                    />
                    <YAxis stroke="#71717a" fontSize={11} domain={["auto", "auto"]} />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelFormatter={(label) => seriesKeyToTime(String(label))}
                      formatter={(value) => [formatIndian(value as number), ""]}
                    />
                    <Legend wrapperStyle={{ fontSize: "12px" }} />
                    {activeSample && (
                      <ReferenceLine
                        x={activeSample.key}
                        stroke="#a855f7"
                        strokeDasharray="4 4"
                        label={{ value: activeSample.time, fill: "#a855f7", fontSize: 10 }}
                      />
                    )}
                    <Line
                      type="monotone"
                      dataKey="spot"
                      name="Spot"
                      stroke="#38bdf8"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="maxPain"
                      name="Max Pain"
                      stroke="#f43f5e"
                      strokeWidth={2}
                      strokeDasharray="6 3"
                      dot={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Chart 6: Total Open Interest (CE vs PE) */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 shadow-lg">
              <h3 className="text-sm font-bold text-zinc-100 mb-1">
                Total Open Interest (CE vs PE)
              </h3>
              <p className="text-xs text-zinc-400 mb-3">
                Contract build-up across the session: writing shows up as a rising line
              </p>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis
                      dataKey="key"
                      tickFormatter={seriesKeyToTime}
                      interval="preserveStartEnd"
                      minTickGap={40}
                      stroke="#71717a"
                      fontSize={11}
                    />
                    <YAxis
                      stroke="#71717a"
                      fontSize={11}
                      tickFormatter={(value) => formatIndian(value as number)}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelFormatter={(label) => seriesKeyToTime(String(label))}
                      formatter={(value) => [formatIndian(value as number), ""]}
                    />
                    <Legend wrapperStyle={{ fontSize: "12px" }} />
                    {activeSample && (
                      <ReferenceLine
                        x={activeSample.key}
                        stroke="#a855f7"
                        strokeDasharray="4 4"
                        label={{ value: activeSample.time, fill: "#a855f7", fontSize: 10 }}
                      />
                    )}
                    <Line
                      type="monotone"
                      dataKey="ceOi"
                      name="Total CE OI"
                      stroke="#f43f5e"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="peOi"
                      name="Total PE OI"
                      stroke="#10b981"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
