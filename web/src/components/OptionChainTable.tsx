"use client";

import React, { useMemo } from "react";
import { StrikeRow } from "@/types/option-chain";
import { formatIndian } from "@/lib/supabase";

interface OptionChainTableProps {
  rows: StrikeRow[];
  spot: number;
  strikeRange: number; // 0 for all, 10, 20, 30
}

export function OptionChainTable({
  rows,
  spot,
  strikeRange,
}: OptionChainTableProps) {
  // Find ATM strike (closest to spot)
  const atmStrike = useMemo(() => {
    if (!rows || rows.length === 0 || !spot) return null;
    let closest = rows[0].STRIKE;
    let minDiff = Math.abs(closest - spot);

    for (const r of rows) {
      const diff = Math.abs(r.STRIKE - spot);
      if (diff < minDiff) {
        minDiff = diff;
        closest = r.STRIKE;
      }
    }
    return closest;
  }, [rows, spot]);

  // Trim around ATM strike
  const displayedRows = useMemo(() => {
    if (!rows || rows.length === 0) return [];
    if (!strikeRange || !atmStrike) return rows;

    const atmIdx = rows.findIndex((r) => r.STRIKE === atmStrike);
    if (atmIdx === -1) return rows;

    const start = Math.max(0, atmIdx - strikeRange);
    const end = Math.min(rows.length, atmIdx + strikeRange + 1);
    return rows.slice(start, end);
  }, [rows, atmStrike, strikeRange]);

  const renderChange = (chng?: number) => {
    if (chng === undefined || chng === null) return "-";
    const isNeg = chng < 0;
    const isPos = chng > 0;
    return (
      <span
        className={`font-mono text-xs ${
          isNeg ? "text-rose-400" : isPos ? "text-emerald-400" : "text-zinc-400"
        }`}
      >
        {isPos ? `+${chng.toFixed(2)}` : chng.toFixed(2)}
      </span>
    );
  };

  return (
    <div className="border border-zinc-800 rounded-xl overflow-hidden bg-zinc-950/70 shadow-xl">
      <div className="overflow-x-auto max-h-[640px]">
        <table className="w-full text-xs text-left border-collapse">
          {/* Super Header */}
          <thead className="sticky top-0 z-20 bg-zinc-900 border-b border-zinc-800">
            <tr className="border-b border-zinc-800/80">
              <th
                colSpan={6}
                className="py-2 px-3 text-center font-bold tracking-wider text-rose-300 bg-rose-950/30 border-r border-zinc-800 uppercase"
              >
                CALLS (CE)
              </th>
              <th className="py-2 px-4 text-center font-bold text-zinc-100 bg-zinc-900 border-r border-zinc-800">
                STRIKE
              </th>
              <th
                colSpan={6}
                className="py-2 px-3 text-center font-bold tracking-wider text-emerald-300 bg-emerald-950/30 uppercase"
              >
                PUTS (PE)
              </th>
            </tr>
            {/* Column Headers */}
            <tr className="text-[11px] font-semibold text-zinc-400 bg-zinc-900/90 border-b border-zinc-800">
              {/* Calls */}
              <th className="py-2 px-2.5 text-right">OI</th>
              <th className="py-2 px-2.5 text-right">Chng OI</th>
              <th className="py-2 px-2.5 text-right">Volume</th>
              <th className="py-2 px-2.5 text-right">IV</th>
              <th className="py-2 px-2.5 text-right">LTP</th>
              <th className="py-2 px-2.5 text-right border-r border-zinc-800">Chng</th>

              {/* Strike */}
              <th className="py-2 px-4 text-center font-bold text-zinc-100 bg-zinc-800/60 border-r border-zinc-800">
                Strike
              </th>

              {/* Puts */}
              <th className="py-2 px-2.5 text-left">Chng</th>
              <th className="py-2 px-2.5 text-left">LTP</th>
              <th className="py-2 px-2.5 text-left">IV</th>
              <th className="py-2 px-2.5 text-left">Volume</th>
              <th className="py-2 px-2.5 text-left">Chng OI</th>
              <th className="py-2 px-2.5 text-left">OI</th>
            </tr>
          </thead>

          {/* Table Body */}
          <tbody className="divide-y divide-zinc-800/50 font-mono">
            {displayedRows.map((row) => {
              const isAtm = row.STRIKE === atmStrike;
              const isCeItm = spot !== null && row.STRIKE < spot;
              const isPeItm = spot !== null && row.STRIKE > spot;

              return (
                <tr
                  key={row.STRIKE}
                  className={`transition-colors hover:bg-zinc-800/40 ${
                    isAtm ? "bg-amber-500/10" : ""
                  }`}
                >
                  {/* CALLS SIDE */}
                  <td
                    className={`py-2 px-2.5 text-right text-zinc-300 ${
                      isCeItm ? "bg-amber-950/20" : ""
                    }`}
                  >
                    {formatIndian(row.CE_OI)}
                  </td>
                  <td
                    className={`py-2 px-2.5 text-right ${
                      isCeItm ? "bg-amber-950/20" : ""
                    } ${
                      (row.CE_CHNG_IN_OI ?? 0) < 0
                        ? "text-rose-400"
                        : (row.CE_CHNG_IN_OI ?? 0) > 0
                        ? "text-emerald-400"
                        : "text-zinc-400"
                    }`}
                  >
                    {formatIndian(row.CE_CHNG_IN_OI)}
                  </td>
                  <td
                    className={`py-2 px-2.5 text-right text-zinc-400 ${
                      isCeItm ? "bg-amber-950/20" : ""
                    }`}
                  >
                    {formatIndian(row.CE_VOLUME)}
                  </td>
                  <td
                    className={`py-2 px-2.5 text-right text-zinc-400 ${
                      isCeItm ? "bg-amber-950/20" : ""
                    }`}
                  >
                    {row.CE_IV ? row.CE_IV.toFixed(2) : "-"}
                  </td>
                  <td
                    className={`py-2 px-2.5 text-right font-bold text-zinc-100 ${
                      isCeItm ? "bg-amber-950/20 text-amber-200" : ""
                    }`}
                  >
                    {formatIndian(row.CE_LTP, 2)}
                  </td>
                  <td
                    className={`py-2 px-2.5 text-right border-r border-zinc-800 ${
                      isCeItm ? "bg-amber-950/20" : ""
                    }`}
                  >
                    {renderChange(row.CE_CHNG)}
                  </td>

                  {/* STRIKE PRICE */}
                  <td
                    className={`py-2 px-4 text-center font-bold tracking-wide border-r border-zinc-800 ${
                      isAtm
                        ? "bg-amber-500 text-zinc-950 font-black shadow-sm"
                        : "bg-zinc-900 text-sky-400"
                    }`}
                  >
                    {formatIndian(row.STRIKE, 0)}
                  </td>

                  {/* PUTS SIDE */}
                  <td
                    className={`py-2 px-2.5 text-left ${
                      isPeItm ? "bg-amber-950/20" : ""
                    }`}
                  >
                    {renderChange(row.PE_CHNG)}
                  </td>
                  <td
                    className={`py-2 px-2.5 text-left font-bold text-zinc-100 ${
                      isPeItm ? "bg-amber-950/20 text-amber-200" : ""
                    }`}
                  >
                    {formatIndian(row.PE_LTP, 2)}
                  </td>
                  <td
                    className={`py-2 px-2.5 text-left text-zinc-400 ${
                      isPeItm ? "bg-amber-950/20" : ""
                    }`}
                  >
                    {row.PE_IV ? row.PE_IV.toFixed(2) : "-"}
                  </td>
                  <td
                    className={`py-2 px-2.5 text-left text-zinc-400 ${
                      isPeItm ? "bg-amber-950/20" : ""
                    }`}
                  >
                    {formatIndian(row.PE_VOLUME)}
                  </td>
                  <td
                    className={`py-2 px-2.5 text-left ${
                      isPeItm ? "bg-amber-950/20" : ""
                    } ${
                      (row.PE_CHNG_IN_OI ?? 0) < 0
                        ? "text-rose-400"
                        : (row.PE_CHNG_IN_OI ?? 0) > 0
                        ? "text-emerald-400"
                        : "text-zinc-400"
                    }`}
                  >
                    {formatIndian(row.PE_CHNG_IN_OI)}
                  </td>
                  <td
                    className={`py-2 px-2.5 text-left text-zinc-300 ${
                      isPeItm ? "bg-amber-950/20" : ""
                    }`}
                  >
                    {formatIndian(row.PE_OI)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
