"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Download,
  FileSpreadsheet,
  Loader2,
  Play,
  Power,
  RefreshCw,
  Timer,
  X,
} from "lucide-react";

/** Local helper started with `python excel\excel_server.py` or `excel\excel_server.bat`. */
const HELPER = "http://127.0.0.1:8765";
const MIN_MINUTES = 1;
const MAX_MINUTES = 60;

interface ExcelStatus {
  ok: boolean;
  helper?: string;
  com?: boolean;
  symbol?: string;
  expiry?: string | null;
  interval?: number;
  running?: boolean;
  busy?: boolean;
  error?: string | null;
  note?: string | null;
  rows?: number;
  updated?: string | null;
  age_seconds?: number | null;
  workbook?: string | null;
  folder?: string;
  stopped?: number;
}

type Pending = "live" | "timer" | "download" | "stop" | null;
type Link = "checking" | "online" | "offline";

async function fetchJson(path: string, timeoutMs: number): Promise<ExcelStatus> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${HELPER}${path}`, {
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = (await res.json().catch(() => null)) as ExcelStatus | null;
    if (!payload) throw new Error(`Excel helper returned HTTP ${res.status}.`);
    if (!res.ok || payload.ok === false) {
      throw new Error(payload.error || `Excel helper returned HTTP ${res.status}.`);
    }
    return payload;
  } finally {
    window.clearTimeout(timer);
  }
}

function ageLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "no snapshot yet";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The Excel helper did not answer in time.";
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

interface ExcelPanelProps {
  onClose: () => void;
}

export function ExcelPanel({ onClose }: ExcelPanelProps) {
  const [link, setLink] = useState<Link>("checking");
  const [status, setStatus] = useState<ExcelStatus | null>(null);
  const [minutes, setMinutes] = useState("1");
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(false);

  const poll = useCallback(async () => {
    try {
      const payload = await fetchJson("/health", 4000);
      setStatus(payload);
      setLink("online");
      if (!touched.current && payload.interval) {
        setMinutes(String(payload.interval));
      }
    } catch {
      setStatus(null);
      setLink("offline");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async () => {
      await poll();
      if (alive) timer = window.setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [poll]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const parsed = Number.parseInt(minutes, 10);
  const valid = Number.isFinite(parsed) && parsed >= MIN_MINUTES && parsed <= MAX_MINUTES;
  const busy = pending !== null || status?.busy === true;

  const setTimer = async (mode: "live" | "timer") => {
    if (!valid) {
      setError(`Enter a whole number between ${MIN_MINUTES} and ${MAX_MINUTES}.`);
      return;
    }
    setPending(mode);
    setError(null);
    try {
      const payload = await fetchJson(`/live?interval=${parsed}`, 30000);
      setStatus(payload);
      setLink("online");
    } catch (err) {
      setError(errorText(err, "Could not start the Excel workbook."));
      setLink("offline");
    } finally {
      setPending(null);
    }
  };

  const stopUpdater = async () => {
    setPending("stop");
    setError(null);
    try {
      const payload = await fetchJson("/stop", 5000);
      setStatus(payload);
      setLink("online");
    } catch (err) {
      setError(errorText(err, "Could not stop the background updater."));
    } finally {
      setPending(null);
    }
  };

  const download = async () => {
    setPending("download");
    setError(null);
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 60000);
      let res: Response;
      try {
        res = await fetch(`${HELPER}/download`, {
          signal: controller.signal,
          cache: "no-store",
        });
      } finally {
        window.clearTimeout(timer);
      }
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as ExcelStatus | null;
        throw new Error(payload?.error || `Excel helper returned HTTP ${res.status}.`);
      }
      const disposition = res.headers.get("Content-Disposition") || "";
      const name = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || "NSE_Option_Chain.xlsx";
      const url = URL.createObjectURL(await res.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorText(err, "Could not build the workbook."));
    } finally {
      setPending(null);
    }
  };

  const workbookState = status?.running
    ? { text: "Updater running", tone: "text-emerald-400" }
    : status?.busy
    ? { text: "Starting updater…", tone: "text-amber-400" }
    : { text: "Updater stopped", tone: "text-zinc-400" };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/70 backdrop-blur-sm px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="excel-panel-title"
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
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
                NIFTY · nearest expiry · full chain, formatted like the NSE page.
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
          {link === "checking" && (
            <p className="flex items-center gap-2 text-xs text-zinc-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Looking for the local Excel helper…
            </p>
          )}

          {link === "offline" && (
            <div className="rounded-lg border border-amber-900/70 bg-amber-950/20 p-4 text-xs text-amber-200">
              <p className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="w-3.5 h-3.5" />
                Excel helper is not running
              </p>
              <p className="mt-2 text-amber-200/80">
                Start it on this PC, then keep the window open:
              </p>
              <code className="mt-2 block rounded bg-black/40 px-3 py-2 font-mono text-[11px] text-amber-100">
                python excel\excel_server.py
              </code>
              <p className="mt-2 text-amber-200/80">
                or double-click <span className="font-mono">excel\excel_server.bat</span>.
                It only listens on 127.0.0.1, so nothing is exposed to the internet.
              </p>
            </div>
          )}

          {link === "online" && status && (
            <>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                  <p className="text-zinc-500">Chain</p>
                  <p className="mt-0.5 font-semibold text-zinc-200">
                    {status.symbol || "NIFTY"}
                    {status.expiry ? ` · ${status.expiry}` : ""}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                  <p className="text-zinc-500">Strikes in file</p>
                  <p className="mt-0.5 font-semibold text-zinc-200">
                    {status.rows ? status.rows.toLocaleString() : "—"}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                  <p className="text-zinc-500">Local copy</p>
                  <p className="mt-0.5 font-semibold text-zinc-200">
                    {ageLabel(status.age_seconds)}
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                  <p className="text-zinc-500">Background updater</p>
                  <p className={`mt-0.5 font-semibold ${workbookState.tone}`}>
                    {workbookState.text}
                  </p>
                </div>
              </div>

              {status.com === false && (
                <p className="rounded-lg border border-amber-900/70 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
                  pywin32 is missing, so the self-refreshing workbook cannot be set
                  up. Run <span className="font-mono">pip install -r excel\requirements-excel.txt</span>.
                </p>
              )}

              <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <label
                  htmlFor="excel-interval"
                  className="flex items-center gap-2 text-xs font-semibold text-zinc-300"
                >
                  <Timer className="w-3.5 h-3.5 text-zinc-400" />
                  NSE refresh timer
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    id="excel-interval"
                    type="number"
                    min={MIN_MINUTES}
                    max={MAX_MINUTES}
                    step={1}
                    value={minutes}
                    onChange={(event) => {
                      touched.current = true;
                      setMinutes(event.target.value);
                    }}
                    className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                  />
                  <span className="text-xs text-zinc-400">
                    minutes between NSE fetches ({MIN_MINUTES}–{MAX_MINUTES})
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {[1, 3, 5, 15].map((preset) => (
                    <button
                      key={preset}
                      onClick={() => {
                        touched.current = true;
                        setMinutes(String(preset));
                      }}
                      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                        parsed === preset
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                          : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {preset} min
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                  Excel re-reads its local copy every minute. Changing this timer
                  restarts the background fetcher only — keep the workbook open
                  and nothing has to be re-created.
                </p>
              </div>

              {status.note && !status.error && (
                <p className="text-[11px] text-zinc-400">{status.note}</p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void setTimer("live")}
                  disabled={busy || !valid}
                  className="flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-zinc-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
                >
                  {pending === "live" || status.busy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                  Open live workbook
                </button>

                <button
                  onClick={() => void setTimer("timer")}
                  disabled={busy || !valid || !status.running}
                  className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                  title="Restart the background fetcher with the new interval"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${pending === "timer" ? "animate-spin" : ""}`} />
                  Update timer
                </button>

                <button
                  onClick={() => void download()}
                  disabled={pending !== null}
                  className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-50"
                >
                  {pending === "download" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  Download .xlsx
                </button>

                {status.running && (
                  <button
                    onClick={() => void stopUpdater()}
                    disabled={pending !== null}
                    className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-zinc-400 transition-colors hover:text-rose-300 disabled:opacity-50"
                    title="Stop fetching from NSE; the open workbook keeps its last data"
                  >
                    <Power className="w-3.5 h-3.5" />
                    Stop
                  </button>
                )}
              </div>

              <p className="text-[11px] text-zinc-500">
                Downloads a fresh formatted <span className="font-mono">.xlsx</span>;
                &ldquo;Open live workbook&rdquo; starts Excel on this PC and keeps the
                sheet updated until you close it.
              </p>
            </>
          )}

          {error && (
            <p role="alert" className="rounded-lg border border-rose-900/70 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200">
              {error}
            </p>
          )}

          {status?.error && (
            <p role="alert" className="rounded-lg border border-rose-900/70 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200">
              {status.error}
            </p>
          )}
        </div>

        {status?.folder && (
          <div className="border-t border-zinc-800 px-5 py-3">
            <p className="truncate text-[11px] text-zinc-500" title={status.folder}>
              Output folder: <span className="font-mono">{status.folder}</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
