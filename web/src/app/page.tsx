"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Header } from "@/components/Header";
import { MetricsBar } from "@/components/MetricsBar";
import { OptionChainTable } from "@/components/OptionChainTable";
import { ChartsView } from "@/components/ChartsView";
import { ExcelPanel } from "@/components/ExcelPanel";
import { OptionChainRecord, OptionChainHistoryPoint } from "@/types/option-chain";
import { getSnapshotStatus, isOptionChainRecord, supabase } from "@/lib/supabase";
import { AlertCircle, BarChart3, Table, SlidersHorizontal } from "lucide-react";

const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY"];
const STRIKE_RANGES = [
  { label: "10 Strikes", value: 10 },
  { label: "20 Strikes", value: 20 },
  { label: "30 Strikes", value: 30 },
  { label: "All Strikes", value: 0 },
];

export default function Home() {
  const [selectedSymbol, setSelectedSymbol] = useState("NIFTY");
  const [data, setData] = useState<OptionChainRecord | null>(null);
  const [history, setHistory] = useState<OptionChainHistoryPoint[]>([]);
  const [activeTab, setActiveTab] = useState<"table" | "charts">("table");
  const [strikeRange, setStrikeRange] = useState(15);
  const [isLoading, setIsLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [excelOpen, setExcelOpen] = useState(false);
  const requestId = useRef(0);

  const fetchData = useCallback(async () => {
    const currentRequestId = ++requestId.current;
    setIsLoading(true);
    setConnectionError(null);
    try {
      if (!supabase) {
        throw new Error("Supabase is not configured. Set the public URL and anon key.");
      }

      const { data: liveRows, error: liveError } = await supabase
        .from("option_chain_live")
        .select("*")
        .eq("symbol", selectedSymbol)
        .order("updated_at", { ascending: false })
        .limit(50);
      if (liveError) throw new Error(`Snapshot query failed: ${liveError.message}`);

      const latest = Array.isArray(liveRows)
        ? liveRows.find((row) => isOptionChainRecord(row, selectedSymbol))
        : null;
      if (currentRequestId !== requestId.current) return;
      setData((latest as OptionChainRecord | undefined) ?? null);
      setHistoryError(null);

      if (!latest) {
        setHistory([]);
        return;
      }

      const { data: historyRows, error: historyQueryError } = await supabase
        .from("option_chain_history")
        .select("*")
        .eq("symbol", selectedSymbol)
        .eq("expiry", latest.expiry)
        .order("created_at", { ascending: false })
        .limit(30);
      if (currentRequestId !== requestId.current) return;
      if (historyQueryError) {
        setHistory([]);
        setHistoryError(`History query failed: ${historyQueryError.message}`);
      } else {
        setHistory((historyRows ?? []).reverse() as OptionChainHistoryPoint[]);
      }
    } catch (error) {
      if (currentRequestId === requestId.current) {
        setConnectionError(error instanceof Error ? error.message : "Supabase connection failed.");
        setHistory([]);
      }
    } finally {
      if (currentRequestId === requestId.current) setIsLoading(false);
    }
  }, [selectedSymbol]);

  useEffect(() => {
    const initialFetch = window.setTimeout(() => {
      void fetchData();
    }, 0);
    const interval = setInterval(() => {
      fetchData();
    }, 30000); // 30 second auto-poll
    return () => {
      window.clearTimeout(initialFetch);
      clearInterval(interval);
    };
  }, [fetchData]);

  const visibleData = data?.symbol === selectedSymbol ? data : null;
  const status = isLoading && !visibleData
    ? "Loading"
    : visibleData
    ? getSnapshotStatus(visibleData.nse_timestamp)
    : "Unavailable";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500 selection:text-zinc-950">
      <Header
        selectedSymbol={selectedSymbol}
        onSelectSymbol={(sym) => {
          requestId.current += 1;
          setSelectedSymbol(sym);
          setData(null);
          setHistory([]);
          setConnectionError(null);
          setHistoryError(null);
        }}
        symbols={SYMBOLS}
        expiry={visibleData?.expiry || ""}
        nseTimestamp={visibleData?.nse_timestamp ?? null}
        status={status}
        onRefresh={fetchData}
        onOpenExcel={() => setExcelOpen(true)}
        isLoading={isLoading}
      />

      <main className="max-w-7xl mx-auto px-4 py-4">
        {/* Top Analytics Metrics */}
        {visibleData && (
          <MetricsBar
            symbol={visibleData.symbol}
            spot={visibleData.spot}
            pcr={visibleData.pcr}
            maxPain={visibleData.max_pain}
            totalCeOi={visibleData.total_ce_oi}
            totalPeOi={visibleData.total_pe_oi}
          />
        )}

        {connectionError && (
          <div role="alert" className="my-4 flex items-start gap-3 border border-rose-900/70 bg-rose-950/30 p-4 text-sm text-rose-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Supabase connection error</p>
              <p className="mt-1 text-rose-200/80">{connectionError}</p>
              {visibleData && <p className="mt-1 text-rose-200/80">Showing the last loaded NSE snapshot; its source status is shown above.</p>}
            </div>
          </div>
        )}

        {historyError && (
          <div role="alert" className="my-3 border border-amber-900/70 bg-amber-950/20 p-3 text-xs text-amber-200">
            {historyError}
          </div>
        )}

        {!isLoading && !connectionError && !visibleData && (
          <div className="my-6 border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-300">
            No valid NSE snapshot is available for {selectedSymbol}.
          </div>
        )}

        {visibleData && status === "Stale" && (
          <div role="status" className="my-3 border border-amber-900/70 bg-amber-950/20 p-3 text-xs text-amber-200">
            This snapshot is stale. Source timestamp: {visibleData.nse_timestamp || "unavailable"}.
          </div>
        )}

        {visibleData && status === "Unavailable" && (
          <div role="status" className="my-3 border border-amber-900/70 bg-amber-950/20 p-3 text-xs text-amber-200">
            The source timestamp is missing or invalid; freshness cannot be confirmed.
          </div>
        )}

        {/* Tab & Filter Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 my-4 pb-3 border-b border-zinc-800">
          {/* View Mode Tabs */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1 self-start">
            <button
              onClick={() => setActiveTab("table")}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                activeTab === "table"
                  ? "bg-zinc-800 text-zinc-100 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Table className="w-3.5 h-3.5" />
              Option Chain Table
            </button>
            <button
              onClick={() => setActiveTab("charts")}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${
                activeTab === "charts"
                  ? "bg-zinc-800 text-zinc-100 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              Interactive Charts
            </button>
          </div>

          {/* Strike Range Selector */}
          {activeTab === "table" && (
            <div className="flex items-center gap-2 text-xs">
              <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-zinc-400">Strikes Around ATM:</span>
              <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-md p-0.5">
                {STRIKE_RANGES.map((rng) => (
                  <button
                    key={rng.label}
                    onClick={() => setStrikeRange(rng.value)}
                    className={`px-2 py-1 text-[11px] font-medium rounded transition-all ${
                      strikeRange === rng.value
                        ? "bg-zinc-800 text-emerald-400"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {rng.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Content View */}
        {visibleData && (
          <div>
            {activeTab === "table" ? (
              <OptionChainTable
                rows={visibleData.raw_data || []}
                spot={visibleData.spot}
                strikeRange={strikeRange}
              />
            ) : (
              <ChartsView
                rows={visibleData.raw_data || []}
                spot={visibleData.spot}
                history={history}
              />
            )}
          </div>
        )}

      </main>

      {excelOpen && <ExcelPanel onClose={() => setExcelOpen(false)} />}

      {/* Footer */}
      <footer className="border-t border-zinc-800/80 mt-12 py-6 text-center text-xs text-zinc-500">
        <p>NSE Option Chain Quantitative Dashboard &copy; 2026</p>
        <p className="mt-1">For personal research and educational purposes only.</p>
      </footer>
    </div>
  );
}
