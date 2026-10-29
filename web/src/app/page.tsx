"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "@/components/Header";
import { MetricsBar } from "@/components/MetricsBar";
import { OptionChainTable } from "@/components/OptionChainTable";
import { ChartsView } from "@/components/ChartsView";
import { ExcelPanel } from "@/components/ExcelPanel";
import { ImportCsvPanel } from "@/components/ImportCsvPanel";
import {
  OptionChainHistoryPoint,
  OptionChainRecord,
} from "@/types/option-chain";
import {
  type ChainMeta,
  type ChainResponse,
  type ExpiriesResponse,
  type ExpiryOption,
  type HistoryResponse,
  type RefreshMinutes,
  type UiStatus,
} from "@/lib/api-types";
import {
  DEFAULT_FIELD_GROUPS,
  DEFAULT_STRIKE_RANGE,
  STRIKE_RANGE_OPTIONS,
  strikeRadius,
  type FieldGroup,
  type StrikeRange,
} from "@/lib/chain-selection";
import { normalizeOptionChainRecord } from "@/lib/option-chain-record";
import type { CsvImportMeta } from "@/lib/nse-csv-import";
import { buildOptionChainWorkbook } from "@/lib/excel-export";
import { RefreshGuard, shouldRefreshOnReturn } from "@/lib/refresh-guard";
import { AlertCircle, BarChart3, Download, RefreshCw, Table, SlidersHorizontal } from "lucide-react";

const SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY"];

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  return body?.error?.message || fallback;
}

export default function Home() {
  const [selectedSymbol, setSelectedSymbol] = useState("NIFTY");
  /** null = newest snapshot for the symbol. */
  const [selectedExpiry, setSelectedExpiry] = useState<string | null>(null);
  const [expiries, setExpiries] = useState<ExpiryOption[]>([]);

  const [data, setData] = useState<OptionChainRecord | null>(null);
  const [meta, setMeta] = useState<ChainMeta | null>(null);
  const [history, setHistory] = useState<OptionChainHistoryPoint[]>([]);

  const [activeTab, setActiveTab] = useState<"table" | "charts">("table");
  const [strikeRange, setStrikeRange] = useState<StrikeRange>(DEFAULT_STRIKE_RANGE);
  const [fieldGroups, setFieldGroups] = useState<FieldGroup[]>(DEFAULT_FIELD_GROUPS);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshMinutes, setRefreshMinutes] = useState<RefreshMinutes>(1);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);

  const [excelOpen, setExcelOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  /**
   * A snapshot the user imported from an NSE CSV, parsed in this browser.
   * While it is set it becomes the selected data source and the hosted API is
   * not polled, so the dashboard never mixes an imported chain with stored
   * rows. Cleared to fall back to the hosted snapshots.
   */
  const [imported, setImported] = useState<{
    record: OptionChainRecord;
    meta: CsvImportMeta;
  } | null>(null);

  // Created once; survives renders and owns the AbortController.
  const [guard] = useState(() => new RefreshGuard());

  const fetchData = useCallback(async () => {
    // An imported CSV is the selected source; do not mix in stored rows.
    if (imported) return;
    const requestKey = `${selectedSymbol}|${selectedExpiry ?? "newest"}`;
    // One read at a time per symbol+expiry: polling, Refresh Now and the panel
    // all share this guard, so a slow query can never overlap another one.
    const ticket = guard.begin(requestKey);
    if (!ticket) return;
    const { signal } = ticket;

    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        symbol: selectedSymbol,
        format: "json",
        range: "all",
        fields: "all",
      });
      if (selectedExpiry) params.set("expiry", selectedExpiry);

      const response = await fetch(`/api/option-chain?${params.toString()}`, {
        cache: "no-store",
        signal,
      });

      if (response.status === 404 && selectedExpiry) {
        // The selected expiry no longer exists: drop back to the newest stored
        // snapshot instead of showing an empty page.
        setSelectedExpiry(null);
        return;
      }
      if (!response.ok) {
        throw new Error(await readError(response, `Snapshot request failed (HTTP ${response.status}).`));
      }

      const body = (await response.json()) as ChainResponse;
      const record = normalizeOptionChainRecord({
        symbol: body.meta.symbol,
        expiry: body.meta.expiry,
        spot: body.meta.spot,
        pcr: body.meta.pcr,
        max_pain: body.meta.max_pain,
        total_ce_oi: body.meta.total_ce_oi,
        total_pe_oi: body.meta.total_pe_oi,
        nse_timestamp: body.meta.nse_timestamp,
        updated_at: body.meta.snapshot_updated_at,
        raw_data: body.chain,
      });

      if (!record) {
        throw new Error("The API returned a snapshot that failed validation.");
      }

      setData(record);
      setMeta(body.meta);
      setLastRefreshAt(new Date());

      // History is a nice-to-have: a failure there must not hide the chain.
      const historyParams = new URLSearchParams({
        symbol: record.symbol,
        expiry: record.expiry,
        limit: "60",
      });
      try {
        const historyResponse = await fetch(
          `/api/option-chain/history?${historyParams.toString()}`,
          { cache: "no-store", signal },
        );
        if (!historyResponse.ok) {
          throw new Error(
            await readError(historyResponse, `History request failed (HTTP ${historyResponse.status}).`),
          );
        }
        const historyBody = (await historyResponse.json()) as HistoryResponse;
        setHistory(Array.isArray(historyBody.points) ? historyBody.points : []);
        setHistoryError(null);
      } catch (historyFailure) {
        if (signal.aborted) return;
        setHistory([]);
        setHistoryError(
          historyFailure instanceof Error ? historyFailure.message : "History is unavailable.",
        );
      }
    } catch (failure) {
      if (signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "Could not reach the snapshot API.");
      setHistory([]);
    } finally {
      guard.finish(ticket.key);
      if (!signal.aborted) setIsLoading(false);
    }
  }, [selectedSymbol, selectedExpiry, guard, imported]);

  // Chain + history whenever the symbol or expiry changes.
  useEffect(() => {
    if (typeof window === "undefined" || imported) return;
    const timer = window.setTimeout(() => {
      void fetchData();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchData, imported]);

  // Available expiries are read from the database, never invented.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      try {
        const params = new URLSearchParams({ symbol: selectedSymbol });
        const response = await fetch(`/api/option-chain/expiries?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!response.ok) {
          setExpiries([]);
          return;
        }
        const body = (await response.json()) as ExpiriesResponse;
        setExpiries(Array.isArray(body.expiries) ? body.expiries : []);
      } catch {
        if (!cancelled) setExpiries([]);
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedSymbol]);

  // Timed polling. Pauses in a hidden tab, catches up on return, and restarts
  // cleanly when the interval or the toggle changes. Never polls while an
  // imported CSV is the selected source.
  useEffect(() => {
    if (!autoRefresh || imported) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchData();
    }, refreshMinutes * 60_000);
    return () => window.clearInterval(id);
  }, [autoRefresh, refreshMinutes, fetchData, imported]);

  useEffect(() => {
    if (!autoRefresh || imported) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const due = shouldRefreshOnReturn(
        lastRefreshAt?.getTime() ?? null,
        refreshMinutes * 60_000,
        Date.now(),
      );
      if (due) void fetchData();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [autoRefresh, refreshMinutes, lastRefreshAt, fetchData, imported]);

  useEffect(() => {
    return () => guard.abort();
  }, [guard]);

  // An imported snapshot wins over whatever the API last returned, but only
  // when it matches the symbol currently selected in the header.
  const visibleData = imported
    ? imported.record.symbol === selectedSymbol
      ? imported.record
      : null
    : data?.symbol === selectedSymbol
      ? data
      : null;

  const status: UiStatus = imported
    ? "Imported" // a file the user handed us; never claim Live
    : error
      ? "Error"
      : isLoading && !visibleData
        ? "Loading"
        : meta
          ? meta.status
          : "Unavailable";

  const strikeRadiusValue = strikeRadius(strikeRange);
  const strikesShown = useMemo(() => {
    if (!visibleData) return 0;
    if (strikeRadiusValue === 0) return visibleData.raw_data.length;
    return Math.min(visibleData.raw_data.length, strikeRadiusValue * 2 + 1);
  }, [visibleData, strikeRadiusValue]);

  const handleSelectSymbol = useCallback((symbol: string) => {
    setSelectedSymbol(symbol);
    setSelectedExpiry(null);
    setData(null);
    setMeta(null);
    setHistory([]);
    setError(null);
    setHistoryError(null);
  }, []);

  const handleSelectExpiry = useCallback((expiry: string | null) => {
    setSelectedExpiry(expiry);
    setData(null);
    setMeta(null);
    setHistory([]);
    setError(null);
    setHistoryError(null);
  }, []);

  /**
   * Promote a validated imported snapshot to the selected data source. The
   * header symbol switches to match so the chain is immediately visible, and
   * API polling stays paused for as long as the import is set.
   */
  const handleImport = useCallback((record: OptionChainRecord, meta: CsvImportMeta) => {
    setImported({ record, meta });
    setSelectedSymbol(record.symbol);
    setSelectedExpiry(record.expiry);
    setData(null);
    setMeta(null);
    setHistory([]);
    setError(null);
    setHistoryError(null);
  }, []);

  const handleClearImport = useCallback(() => {
    setImported(null);
    setData(null);
    setMeta(null);
    setHistory([]);
    setError(null);
    setHistoryError(null);
  }, []);

  /**
   * Excel for an imported snapshot is generated entirely in the browser from
   * the parsed rows, so no server or database is involved. The hosted path
   * keeps using the API export route above.
   */
  const downloadImportedExcel = useCallback(async () => {
    if (!imported || imported.record.symbol !== selectedSymbol || isExporting) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const buffer = await buildOptionChainWorkbook({
        record: imported.record,
        status: "Unavailable",
        ageSeconds: null,
        csvUrl: "",
        // The full dataset, not just the strikes the table is windowed to.
        chainRows: imported.record.raw_data,
        rangeLabel: "All strikes",
        fieldsLabel: "All fields",
        importInfo: {
          fileName: imported.meta.fileName,
          fileSize: imported.meta.fileSize,
          importedAt: imported.meta.importedAt,
          exchangeTimestamp: imported.meta.exchangeTimestamp,
        },
      });

      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${imported.record.symbol}_${imported.record.expiry}_imported.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (failure) {
      setExportError(
        failure instanceof Error ? failure.message : "Could not build the Excel workbook.",
      );
    } finally {
      setIsExporting(false);
    }
  }, [imported, selectedSymbol, isExporting]);

  const downloadExcel = useCallback(async () => {
    if (imported) {
      await downloadImportedExcel();
      return;
    }
    if (!visibleData || !meta || isExporting) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const params = new URLSearchParams({
        symbol: meta.symbol,
        expiry: meta.expiry,
        range: strikeRange,
        fields: fieldGroups.join(","),
      });
      const response = await fetch(`/api/option-chain/export?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(await readError(response, `Export failed (HTTP ${response.status}).`));
      }

      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const fileName =
        match?.[1] ?? `${meta.symbol}_${meta.expiry}_snapshot.xlsx`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (failure) {
      setExportError(
        failure instanceof Error ? failure.message : "Could not download the Excel workbook.",
      );
    } finally {
      setIsExporting(false);
    }
  }, [visibleData, meta, isExporting, strikeRange, fieldGroups, imported, downloadImportedExcel]);

  const checkedAtLabel = lastRefreshAt
    ? lastRefreshAt.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false })
    : null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500 selection:text-zinc-950">
      <Header
        selectedSymbol={selectedSymbol}
        onSelectSymbol={handleSelectSymbol}
        symbols={SYMBOLS}
        expiry={visibleData?.expiry || ""}
        nseTimestamp={
          imported ? imported.meta.exchangeTimestamp : (visibleData?.nse_timestamp ?? null)
        }
        status={status}
        onRefresh={fetchData}
        onOpenExcel={() => setExcelOpen(true)}
        isLoading={isLoading && !imported}
      />

      <main className="max-w-7xl mx-auto px-4 py-4">
        <ImportCsvPanel
          onImport={handleImport}
          hasImport={imported !== null}
          onClear={handleClearImport}
          busy={isExporting}
        />

        {imported && (
          <div
            role="status"
            className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-xs text-sky-200"
          >
            <span className="font-bold uppercase tracking-wider text-sky-300">
              Imported Snapshot
            </span>
            <span>
              <span className="text-sky-300/70">Symbol</span>{" "}
              <strong>{imported.record.symbol}</strong>
            </span>
            <span>
              <span className="text-sky-300/70">Expiry</span> <strong>{imported.record.expiry}</strong>
            </span>
            <span className="max-w-[14rem] truncate">
              <span className="text-sky-300/70">File</span>{" "}
              <strong title={imported.meta.fileName}>{imported.meta.fileName}</strong>
            </span>
            <span>
              <span className="text-sky-300/70">Imported</span>{" "}
              <strong>
                {new Date(imported.meta.importedAt).toLocaleTimeString("en-GB", {
                  timeZone: "Asia/Kolkata",
                  hour12: false,
                })}{" "}
                IST
              </strong>
            </span>
            <span>
              <span className="text-sky-300/70">Exchange timestamp</span>{" "}
              <strong>{imported.meta.exchangeTimestamp ?? "not in file"}</strong>
            </span>
            <span className="text-sky-300/80">
              This is a static file you imported. It is not live data and will not update on its
              own.
            </span>
          </div>
        )}

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

        {error && (
          <div role="alert" className="my-4 flex items-start gap-3 border border-rose-900/70 bg-rose-950/30 p-4 text-sm text-rose-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Snapshot API error</p>
              <p className="mt-1 text-rose-200/80">{error}</p>
              {visibleData && (
                <p className="mt-1 text-rose-200/80">
                  Showing the last snapshot that loaded successfully; its NSE timestamp is shown
                  above. No values were invented.
                </p>
              )}
            </div>
          </div>
        )}

        {historyError && !imported && (
          <div role="status" className="my-3 border border-amber-900/70 bg-amber-950/20 p-3 text-xs text-amber-200">
            Intraday history is unavailable: {historyError}
          </div>
        )}

        {!isLoading && !error && !visibleData && (
          <div className="my-6 border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-300">
            {imported
              ? `The imported file covers ${imported.record.symbol}, so no chain is shown for ` +
                `${selectedSymbol}. Select ${imported.record.symbol} to view the imported snapshot, ` +
                "or clear the import to return to the hosted snapshots."
              : `No valid NSE snapshot is available for ${selectedSymbol}` +
                `${selectedExpiry ? ` · ${selectedExpiry}` : ""}.`}
          </div>
        )}

        {visibleData && !imported && status === "Stale" && (
          <div role="status" className="my-3 border border-amber-900/70 bg-amber-950/20 p-3 text-xs text-amber-200">
            This snapshot is stale. Source timestamp: {visibleData.nse_timestamp || "unavailable"}.
            Refreshing re-reads the stored snapshot; only the NSE collector can make it newer.
          </div>
        )}

        {visibleData && !imported && status === "Unavailable" && (
          <div role="status" className="my-3 border border-amber-900/70 bg-amber-950/20 p-3 text-xs text-amber-200">
            The source timestamp is missing or invalid; freshness cannot be confirmed.
          </div>
        )}

        {/* Tab & filter controls */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 my-4 pb-3 border-b border-zinc-800">
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

          <div className="flex flex-wrap items-center gap-2 self-start xl:self-auto">
            <div className="flex items-center gap-2 text-xs">
              <SlidersHorizontal className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-zinc-400">Strikes:</span>
              <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-md p-0.5">
                {STRIKE_RANGE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setStrikeRange(option.value)}
                    title={option.value === "all" ? "Every strike in the snapshot" : option.label}
                    className={`px-2 py-1 text-[11px] font-medium rounded transition-all ${
                      strikeRange === option.value
                        ? "bg-zinc-800 text-emerald-400"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    {option.value === "all" ? "All" : option.value}
                  </button>
                ))}
              </div>
              <span className="hidden sm:inline text-[11px] text-zinc-500">
                {strikesShown} shown
              </span>
            </div>

            <button
              type="button"
              onClick={() => void fetchData()}
              disabled={isLoading || imported !== null}
              title={
                imported
                  ? "An imported CSV is being shown. Clear the import to read the hosted API again."
                  : "Re-read the newest stored snapshot from the hosted API. This does not contact NSE."
              }
              className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-200 transition-colors hover:border-zinc-700 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
              {isLoading ? "Refreshing…" : "Refresh Data"}
            </button>

            <button
              type="button"
              onClick={() => void downloadExcel()}
              disabled={!visibleData || isExporting}
              title={
                imported
                  ? "Build a three-sheet .xlsx in this browser from the imported snapshot."
                  : "Download the selected symbol, expiry, strike range and import fields as a three-sheet .xlsx workbook."
              }
              className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className={`w-3.5 h-3.5 ${isExporting ? "animate-pulse" : ""}`} />
              {isExporting ? "Building…" : "Download Excel"}
            </button>
          </div>
        </div>

        <p className="-mt-1 mb-4 text-[11px] text-zinc-500">
          {imported
            ? "Showing the imported CSV. This is a static snapshot in your browser; it never becomes live and no data leaves this page."
            : checkedAtLabel
              ? `Last refresh ${checkedAtLabel} IST · ${autoRefresh ? `auto every ${refreshMinutes} min (paused when this tab is hidden)` : "auto-refresh off"} · reads the hosted API, not NSE.`
              : "Waiting for the first snapshot…"}
        </p>

        {exportError && (
          <div role="alert" className="mb-4 flex items-start gap-3 border border-rose-900/70 bg-rose-950/30 p-3 text-xs text-rose-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Excel download failed</p>
              <p className="mt-1 text-rose-200/80">{exportError}</p>
            </div>
          </div>
        )}

        {visibleData && (
          <div>
            {activeTab === "table" ? (
              <OptionChainTable
                rows={visibleData.raw_data}
                spot={visibleData.spot}
                strikeRange={strikeRadiusValue}
              />
            ) : (
              <ChartsView
                rows={visibleData.raw_data}
                spot={visibleData.spot}
                history={history}
              />
            )}
          </div>
        )}
      </main>

      {excelOpen && (
        <ExcelPanel
          symbols={SYMBOLS}
          symbol={selectedSymbol}
          onSymbolChange={handleSelectSymbol}
          expiries={expiries}
          selectedExpiry={selectedExpiry}
          onExpiryChange={handleSelectExpiry}
          strikeRange={strikeRange}
          onStrikeRangeChange={setStrikeRange}
          fieldGroups={fieldGroups}
          onFieldGroupsChange={setFieldGroups}
          autoRefresh={autoRefresh}
          onAutoRefreshChange={setAutoRefresh}
          refreshMinutes={refreshMinutes}
          onRefreshMinutesChange={setRefreshMinutes}
          status={status}
          nseTimestamp={visibleData?.nse_timestamp ?? null}
          snapshotExpiry={visibleData?.expiry ?? null}
          strikeCount={visibleData?.raw_data.length ?? 0}
          lastRefreshAt={lastRefreshAt}
          isLoading={isLoading}
          isExporting={isExporting}
          exportError={exportError}
          onRefresh={fetchData}
          onDownload={downloadExcel}
          onClose={() => setExcelOpen(false)}
        />
      )}

      <footer className="border-t border-zinc-800/80 mt-12 py-6 text-center text-xs text-zinc-500">
        <p>NSE Option Chain Quantitative Dashboard &copy; 2026</p>
        <p className="mt-1">For personal research and educational purposes only.</p>
      </footer>
    </div>
  );
}
