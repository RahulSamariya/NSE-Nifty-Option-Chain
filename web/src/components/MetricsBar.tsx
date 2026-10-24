"use client";

import React from "react";
import { formatIndian } from "@/lib/supabase";
import { ArrowDownRight, ArrowUpRight, Crosshair, DollarSign, Gauge, Layers } from "lucide-react";

interface MetricsBarProps {
  symbol: string;
  spot: number;
  pcr: number | null;
  maxPain: number | null;
  totalCeOi: number;
  totalPeOi: number;
}

export function MetricsBar({
  symbol,
  spot,
  pcr,
  maxPain,
  totalCeOi,
  totalPeOi,
}: MetricsBarProps) {
  const pcrValue = pcr ?? 0;
  const pcrSentiment =
    pcrValue > 1.2 ? "Bullish" : pcrValue < 0.8 ? "Bearish" : "Neutral";
  const pcrColor =
    pcrValue > 1.2
      ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
      : pcrValue < 0.8
      ? "text-rose-400 bg-rose-500/10 border-rose-500/20"
      : "text-amber-400 bg-amber-500/10 border-amber-500/20";

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 my-4">
      {/* Spot Price */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-3.5 flex flex-col justify-between">
        <div className="flex items-center justify-between text-zinc-400 text-xs">
          <span>{symbol} Spot</span>
          <DollarSign className="w-4 h-4 text-emerald-400" />
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-xl md:text-2xl font-bold tracking-tight text-zinc-100">
            {formatIndian(spot, 2)}
          </span>
        </div>
        <div className="text-[11px] text-zinc-500 mt-1">Underlying Spot Index</div>
      </div>

      {/* PCR (OI) */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-3.5 flex flex-col justify-between">
        <div className="flex items-center justify-between text-zinc-400 text-xs">
          <span>PCR (OI)</span>
          <Gauge className="w-4 h-4 text-sky-400" />
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-xl md:text-2xl font-bold tracking-tight text-zinc-100">
            {pcr !== null ? pcr.toFixed(2) : "-"}
          </span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${pcrColor}`}>
            {pcrSentiment}
          </span>
        </div>
        <div className="text-[11px] text-zinc-500 mt-1">Put-Call Sentiment Ratio</div>
      </div>

      {/* Max Pain Strike */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-3.5 flex flex-col justify-between">
        <div className="flex items-center justify-between text-zinc-400 text-xs">
          <span>Max Pain Strike</span>
          <Crosshair className="w-4 h-4 text-purple-400" />
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-xl md:text-2xl font-bold tracking-tight text-purple-300">
            {maxPain ? formatIndian(maxPain) : "-"}
          </span>
        </div>
        <div className="text-[11px] text-zinc-500 mt-1">Minimum Buyer Payoff</div>
      </div>

      {/* Total CE Open Interest */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-3.5 flex flex-col justify-between">
        <div className="flex items-center justify-between text-rose-400 text-xs">
          <span>Total Call (CE) OI</span>
          <ArrowDownRight className="w-4 h-4" />
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-xl md:text-2xl font-bold tracking-tight text-rose-300">
            {formatIndian(totalCeOi)}
          </span>
        </div>
        <div className="text-[11px] text-zinc-500 mt-1">Call Writers Resistance</div>
      </div>

      {/* Total PE Open Interest */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-3.5 flex flex-col justify-between col-span-2 md:col-span-1">
        <div className="flex items-center justify-between text-emerald-400 text-xs">
          <span>Total Put (PE) OI</span>
          <ArrowUpRight className="w-4 h-4" />
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-xl md:text-2xl font-bold tracking-tight text-emerald-300">
            {formatIndian(totalPeOi)}
          </span>
        </div>
        <div className="text-[11px] text-zinc-500 mt-1">Put Writers Support</div>
      </div>
    </div>
  );
}
