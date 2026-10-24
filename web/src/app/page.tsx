"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/Header";
import { MetricsBar } from "@/components/MetricsBar";
import { OptionChainTable } from "@/components/OptionChainTable";
import { ChartsView } from "@/components/ChartsView";
import { OptionChainRecord, OptionChainHistoryPoint } from "@/types/option-chain";
import { supabase, generateMockOptionChain } from "@/lib/supabase";
import { BarChart3, Table, SlidersHorizontal, ShieldCheck } from "lucide-react";

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
  const [isLoading, setIsLoading] = useState(false);
  const [isLive, setIsLive] = useState(false);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      if (supabase) {
        // Query live snapshot from Supabase
        const { data: liveRows, error } = await supabase
          .from("option_chain_live")
          .select("*")
          .eq("symbol", selectedSymbol)
          .single();

        if (error || !liveRows) {
          // If no row found, use mock preview data
          setData(generateMockOptionChain(selectedSymbol));
          setIsLive(false);
        } else {
          setData(liveRows as OptionChainRecord);
          setIsLive(true);
        }

        // Query history timeline
        const { data: histRows } = await supabase
          .from("option_chain_history")
          .select("*")
          .eq("symbol", selectedSymbol)
          .order("created_at", { ascending: true })
          .limit(30);

        if (histRows && histRows.length > 0) {
          setHistory(histRows as OptionChainHistoryPoint[]);
        }
      } else {
        // Fallback when Supabase env vars are not set
        setData(generateMockOptionChain(selectedSymbol));
        setIsLive(false);
      }
    } catch {
      setData(generateMockOptionChain(selectedSymbol));
      setIsLive(false);
    } finally {
      setIsLoading(false);
    }
  }, [selectedSymbol]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => {
      fetchData();
    }, 30000); // 30 second auto-poll
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500 selection:text-zinc-950">
      <Header
        selectedSymbol={selectedSymbol}
        onSelectSymbol={(sym) => {
          setSelectedSymbol(sym);
        }}
        symbols={SYMBOLS}
        expiry={data?.expiry || ""}
        nseTimestamp={data?.nse_timestamp || ""}
        isLive={isLive}
        onRefresh={fetchData}
        isLoading={isLoading}
      />

      <main className="max-w-7xl mx-auto px-4 py-4">
        {/* Top Analytics Metrics */}
        {data && (
          <MetricsBar
            symbol={data.symbol}
            spot={data.spot}
            pcr={data.pcr}
            maxPain={data.max_pain}
            totalCeOi={data.total_ce_oi}
            totalPeOi={data.total_pe_oi}
          />
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
        {data && (
          <div>
            {activeTab === "table" ? (
              <OptionChainTable
                rows={data.raw_data || []}
                spot={data.spot}
                strikeRange={strikeRange}
              />
            ) : (
              <ChartsView
                rows={data.raw_data || []}
                spot={data.spot}
                history={history}
              />
            )}
          </div>
        )}

        {/* Info Banner when in Demo/Preview Mode */}
        {!isLive && (
          <div className="mt-8 p-4 rounded-xl border border-zinc-800/80 bg-zinc-900/40 text-xs text-zinc-400 flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-zinc-200">
                Preview Mode Active (Supabase Not Connected)
              </p>
              <p className="mt-1 text-zinc-400">
                To stream real-time NSE data to this web app, run your local bridge worker:
              </p>
              <code className="inline-block mt-2 px-2.5 py-1 bg-zinc-950 border border-zinc-800 rounded text-emerald-400 font-mono text-[11px]">
                python bridge_worker.py --symbol NIFTY BANKNIFTY
              </code>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800/80 mt-12 py-6 text-center text-xs text-zinc-500">
        <p>NSE Option Chain Quantitative Dashboard &copy; 2026</p>
        <p className="mt-1">For personal research and educational purposes only.</p>
      </footer>
    </div>
  );
}
