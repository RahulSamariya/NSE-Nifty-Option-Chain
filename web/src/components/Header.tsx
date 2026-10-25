"use client";

import React from "react";
import { Activity, FileSpreadsheet, RefreshCw, TrendingUp } from "lucide-react";
import type { SnapshotStatus } from "@/lib/supabase";

interface HeaderProps {
  selectedSymbol: string;
  onSelectSymbol: (sym: string) => void;
  symbols: string[];
  expiry: string;
  nseTimestamp: string | null;
  status: SnapshotStatus | "Loading";
  onRefresh: () => void;
  onOpenExcel: () => void;
  isLoading: boolean;
}

export function Header({
  selectedSymbol,
  onSelectSymbol,
  symbols,
  expiry,
  nseTimestamp,
  status,
  onRefresh,
  onOpenExcel,
  isLoading,
}: HeaderProps) {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-40 px-4 py-3">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Title and Symbol Selector */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                NSE Option Chain
                <span className="text-[10px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                  Terminal
                </span>
              </h1>
              <p className="text-xs text-zinc-400">NSE option chain snapshots</p>
            </div>
          </div>

          {/* Symbol Pills */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-1">
            {symbols.map((sym) => (
              <button
                key={sym}
                onClick={() => onSelectSymbol(sym)}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                  selectedSymbol === sym
                    ? "bg-emerald-500 text-zinc-950 shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {sym}
              </button>
            ))}
          </div>
        </div>

        {/* Status, Expiry, and Refresh */}
        <div className="flex items-center gap-3 self-end md:self-auto flex-wrap">
          <div className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-300">
            <span className="text-zinc-400">Expiry:</span>
            <span className="font-semibold text-emerald-400">{expiry || "Current"}</span>
          </div>

          <div className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-400">
            <Activity className="w-3.5 h-3.5 text-zinc-400" />
            <span>{nseTimestamp || "Source timestamp unavailable"}</span>
          </div>

          <div
            className={`flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full border ${
              status === "Live"
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                : status === "Unavailable" || status === "Loading"
                ? "bg-zinc-800 border-zinc-700 text-zinc-400"
                : "bg-amber-500/10 border-amber-500/30 text-amber-400"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${status === "Live" ? "bg-emerald-400" : "bg-amber-400"}`}
            />
            {status}
          </div>

          <button
            onClick={onOpenExcel}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-xs font-semibold transition-colors"
            title="Excel export and live workbook"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Excel
          </button>

          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 border border-zinc-800 transition-colors disabled:opacity-50"
            title="Refresh Chain"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>
    </header>
  );
}
