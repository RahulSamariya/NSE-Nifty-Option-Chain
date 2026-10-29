"use client";

import React, { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  Clock,
  Download,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Timer,
  X,
} from "lucide-react";
import {
  REFRESH_INTERVAL_OPTIONS,
  type RefreshMinutes,
  type UiStatus,
} from "@/lib/api-types";
import {
  FIELD_GROUPS,
  STRIKE_RANGE_OPTIONS,
  type FieldGroup,
  type StrikeRange,
} from "@/lib/chain-selection";
import type { ExpiryOption } from "@/lib/api-types";
import { buildSetupZipBlob } from "@/lib/excel-setup-package";

interface ExcelPanelProps {
  symbols: string[];
  symbol: string;
  onSymbolChange: (symbol: string) => void;

  expiries: ExpiryOption[];
  selectedExpiry: string | null;
  onExpiryChange: (expiry: string | null) => void;

  strikeRange: StrikeRange;
  onStrikeRangeChange: (range: StrikeRange) => void;

  fieldGroups: FieldGroup[];
  onFieldGroupsChange: (groups: FieldGroup[]) => void;

  autoRefresh: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  refreshMinutes: RefreshMinutes;
  onRefreshMinutesChange: (minutes: RefreshMinutes) => void;

  status: UiStatus;
  nseTimestamp: string | null;
  snapshotExpiry: string | null;
  strikeCount: number;
  lastRefreshAt: Date | null;

  isLoading: boolean;
  isExporting: boolean;
  exportError: string | null;

  onRefresh: () => void;
  onDownload: () => void;
  onClose: () => void;
}

const STATUS_TONE: Record<UiStatus, string> = {
  Live: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
  "Last Close": "bg-amber-500/10 border-amber-500/30 text-amber-300",
  Stale: "bg-amber-500/10 border-amber-500/30 text-amber-300",
  Unavailable: "bg-zinc-800 border-zinc-700 text-zinc-400",
  Loading: "bg-zinc-800 border-zinc-700 text-zinc-400",
  Error: "bg-rose-500/10 border-rose-500/30 text-rose-300",
  Imported: "bg-sky-500/10 border-sky-500/30 text-sky-300",
};

function timeLabel(value: Date | null): string {
  if (!value) return "not yet";
  return value.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
}

export function ExcelPanel(props: ExcelPanelProps) {
  const {
    symbols,
    symbol,
    onSymbolChange,
    expiries,
    selectedExpiry,
    onExpiryChange,
    strikeRange,
    onStrikeRangeChange,
    fieldGroups,
    onFieldGroupsChange,
    autoRefresh,
    onAutoRefreshChange,
    refreshMinutes,
    onRefreshMinutesChange,
    status,
    nseTimestamp,
    snapshotExpiry,
    strikeCount,
    lastRefreshAt,
    isLoading,
    isExporting,
    exportError,
    onRefresh,
    onDownload,
    onClose,
  } = props;

  const [isGeneratingSetup, setIsGeneratingSetup] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const handleDownloadSetup = async () => {
    setIsGeneratingSetup(true);
    setSetupError(null);
    try {
      const origin =
        process.env.NEXT_PUBLIC_APP_URL ||
        (typeof window !== "undefined"
          ? window.location.origin
          : "http://localhost:3000");
      const blob = await buildSetupZipBlob({
        baseUrl: origin,
        symbol,
        expiry: selectedExpiry,
        strikeRange,
        fields: fieldGroups.length === 7 ? "all" : fieldGroups.join(","),
        refreshMinutes,
        autoRefresh,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `NSE_Option_Chain_Excel_Setup_${symbol}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Setup package generation failed:", err);
      setSetupError(
        err instanceof Error
          ? err.message
          : "Failed to generate Excel setup package.",
      );
    } finally {
      setIsGeneratingSetup(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleField = (group: FieldGroup) => {
    const next = fieldGroups.includes(group)
      ? fieldGroups.filter((item) => item !== group)
      : [...fieldGroups, group];
    onFieldGroupsChange(next);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/70 backdrop-blur-sm px-4 py-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="excel-panel-title"
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <h2 id="excel-panel-title" className="text-sm font-bold text-zinc-100">
                Excel export
              </h2>
              <p className="text-xs text-zinc-400">
                Hosted export · every control below runs against the deployed API, no local helper.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            title="Close"
            aria-label="Close Excel panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Status */}
          <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <p className="text-zinc-500">Chain</p>
              <p className="mt-0.5 truncate font-semibold text-zinc-200" title={`${symbol} ${snapshotExpiry ?? ""}`}>
                {symbol}
                {snapshotExpiry ? ` · ${snapshotExpiry}` : ""}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <p className="text-zinc-500">Strikes in snapshot</p>
              <p className="mt-0.5 font-semibold text-zinc-200">
                {strikeCount ? strikeCount.toLocaleString() : "—"}
              </p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <p className="text-zinc-500">Last refresh</p>
              <p className="mt-0.5 font-semibold text-zinc-200">{timeLabel(lastRefreshAt)}</p>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
              <p className="text-zinc-500">NSE source</p>
              <p className="mt-0.5 truncate font-semibold text-zinc-200" title={nseTimestamp ?? "unavailable"}>
                {nseTimestamp ?? "unavailable"}
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-zinc-500">
              Status comes from the NSE timestamp, not from the last click.
            </p>
            <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${STATUS_TONE[status]}`}>
              {status}
            </span>
          </div>

          {/* Symbol + expiry */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <span className="text-xs font-semibold text-zinc-300">Symbol</span>
              <div className="mt-2 flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-1">
                {symbols.map((item) => (
                  <button
                    key={item}
                    onClick={() => onSymbolChange(item)}
                    className={`flex-1 px-2 py-1 text-[11px] font-semibold rounded-md transition-all ${
                      symbol === item
                        ? "bg-emerald-500 text-zinc-950"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <label htmlFor="excel-expiry" className="text-xs font-semibold text-zinc-300">
                Expiry
              </label>
              <select
                id="excel-expiry"
                value={selectedExpiry ?? ""}
                onChange={(event) => onExpiryChange(event.target.value || null)}
                className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
              >
                <option value="">Newest stored snapshot</option>
                {expiries.map((option) => (
                  <option key={option.expiry} value={option.expiry}>
                    {option.expiry}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[10px] text-zinc-500">
                {expiries.length > 0
                  ? `${expiries.length} expiry${expiries.length === 1 ? "" : "ies"} with stored data`
                  : "No expiry list yet — the snapshot request will retry"}
              </p>
            </div>
          </div>

          {/* Strike range */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <span className="text-xs font-semibold text-zinc-300">Strike range</span>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {STRIKE_RANGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => onStrikeRangeChange(option.value)}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    strikeRange === option.value
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-zinc-500">
              Narrower ranges trim the Option Chain sheet. The Raw Data sheet always keeps every
              strike.
            </p>
          </div>

          {/* Import fields */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <span className="text-xs font-semibold text-zinc-300">Import fields</span>
            <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {FIELD_GROUPS.map((group) => {
                const checked = fieldGroups.includes(group.value);
                return (
                  <label
                    key={group.value}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-[11px] text-zinc-300 hover:border-zinc-700"
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() => toggleField(group.value)}
                    />
                    <span
                      className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${
                        checked
                          ? "border-emerald-500 bg-emerald-500 text-zinc-950"
                          : "border-zinc-600 bg-zinc-950"
                      }`}
                      aria-hidden="true"
                    >
                      {checked && <Check className="h-2.5 w-2.5" />}
                    </span>
                    {group.label}
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-[10px] text-zinc-500">
              Summary metrics (spot, PCR, max pain, total OI) are always included. Selecting none
              exports the summary only.
            </p>
          </div>

          {/* Auto refresh */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
                <Timer className="h-3.5 w-3.5 text-zinc-400" />
                Automatic refresh
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={autoRefresh}
                onClick={() => onAutoRefreshChange(!autoRefresh)}
                className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
                  autoRefresh
                    ? "border-emerald-500/50 bg-emerald-500/80"
                    : "border-zinc-700 bg-zinc-800"
                }`}
                title={autoRefresh ? "Pause automatic refresh" : "Resume automatic refresh"}
              >
                <span
                  className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-zinc-950 transition-all ${
                    autoRefresh ? "left-4.5" : "left-0.5"
                  }`}
                />
                <span className="sr-only">
                  {autoRefresh ? "Automatic refresh on" : "Automatic refresh off"}
                </span>
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {REFRESH_INTERVAL_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => onRefreshMinutesChange(option.value)}
                  disabled={!autoRefresh}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                    refreshMinutes === option.value
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
              This only sets how often <em>this browser</em> re-reads the hosted API. It never
              starts an NSE request; the hosted collector owns that. Polling pauses while the tab
              is hidden.
            </p>
          </div>

          {/* One-Click Automated Desktop Excel Setup */}
          <div className="rounded-xl border border-emerald-500/40 bg-gradient-to-b from-emerald-950/30 to-zinc-900/60 p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-emerald-400" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-300">
                    One-Click Live Excel Setup
                  </h3>
                  <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300 border border-emerald-500/30">
                    Recommended
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-300 leading-relaxed">
                  Configures Microsoft Excel Desktop on Windows to connect directly to this hosted API.
                  Includes native Power Query feeds, auto-refresh ({autoRefresh ? `${refreshMinutes} min` : "manual"}), and an in-sheet Settings control panel.
                </p>
                <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-400">
                  <span>Symbol: <strong className="text-zinc-200">{symbol}</strong></span>
                  <span>Expiry: <strong className="text-zinc-200">{selectedExpiry || "latest"}</strong></span>
                  <span>Range: <strong className="text-zinc-200">{strikeRange}</strong></span>
                  <span>Refresh: <strong className="text-zinc-200">{autoRefresh ? `${refreshMinutes} min` : "Manual"}</strong></span>
                  <span>API: <strong className="text-zinc-200 truncate max-w-xs inline-block align-bottom">{typeof window !== "undefined" ? (process.env.NEXT_PUBLIC_APP_URL || window.location.origin) : "Hosted API"}</strong></span>
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadSetup}
                disabled={isGeneratingSetup}
                className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-zinc-950 shadow-md transition-all hover:bg-emerald-400 active:scale-95 disabled:opacity-50"
              >
                {isGeneratingSetup ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {isGeneratingSetup ? "Generating Setup Package…" : "Set Up Excel (1-Click Package)"}
              </button>
            </div>

            {setupError && (
              <p role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-rose-900/70 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {setupError}
              </p>
            )}

            <p className="mt-2.5 text-[10px] leading-relaxed text-zinc-400">
              Downloads a ready-to-run package with <code className="text-emerald-300">Setup-NSE-Excel.bat</code> that automatically provisions a reusable 4-sheet workbook (Summary, Option Chain, Raw Data, Settings) in your Documents folder. No Python or manual M-code required.
            </p>
          </div>

          {/* Quick Snapshot & Refresh Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800/80 pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onRefresh}
                disabled={isLoading}
                className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
                {isLoading ? "Refreshing…" : "Refresh Now"}
              </button>

              <button
                type="button"
                onClick={onDownload}
                disabled={isExporting || strikeCount === 0}
                className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-50"
              >
                {isExporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {isExporting ? "Building workbook…" : "Download Snapshot .xlsx"}
              </button>
            </div>

            <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Clock className="h-3 w-3" />
              {timeLabel(lastRefreshAt)} IST
            </span>
          </div>

          {exportError && (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-900/70 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {exportError}
            </p>
          )}
        </div>

        <div className="border-t border-zinc-800 px-5 py-3">
          <p className="text-[11px] leading-relaxed text-zinc-500">
            For live desktop workflows, use <strong className="text-zinc-300">Set Up Excel (1-Click Package)</strong> above to configure automated Power Query feeds in Microsoft Excel. For one-off static analysis, use <strong className="text-zinc-300">Download Snapshot .xlsx</strong>.
          </p>
        </div>
      </div>
    </div>
  );
}
