"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Clock,
  Database,
  HeartPulse,
  RefreshCw,
  Server,
} from "lucide-react";
import type { HealthPayload, StatusTone } from "@/lib/health-status";
import {
  formatAge,
  formatIst,
  healthTone,
  sessionLabel,
  sessionTone,
  symbolStatusTone,
  workerStateLabel,
  workerStateTone,
} from "@/lib/health-status";
import { formatIndian } from "@/lib/supabase";

const POLL_MS = 30_000;

const TONE_CLASS: Record<StatusTone, string> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  bad: "border-rose-500/30 bg-rose-500/10 text-rose-400",
};

const TONE_DOT: Record<StatusTone, string> = {
  good: "bg-emerald-400",
  info: "bg-sky-400",
  warn: "bg-amber-400",
  bad: "bg-rose-400",
};

const HEALTH_LABEL: Record<string, string> = {
  ok: "Healthy",
  degraded: "Degraded",
  unavailable: "Unavailable",
};

function Badge({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[tone]}`}
    >
      <span className={`h-2 w-2 rounded-full ${TONE_DOT[tone]}`} />
      {children}
    </span>
  );
}

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 shadow-lg">
      <div className="mb-3 flex items-center gap-2 text-zinc-400">
        {icon}
        <h3 className="text-xs font-bold uppercase tracking-wider">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right font-semibold text-zinc-200">{value}</span>
    </div>
  );
}

/**
 * Public read of `/api/health`: what the collector last wrote, how fresh the
 * snapshots are, and why the market session is open or closed. Polls the
 * hosted API only — no credentials and no database access in the browser.
 */
export function StatusView() {
  const [payload, setPayload] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    try {
      const response = await fetch("/api/health", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Status request failed (HTTP ${response.status}).`);
      const body = (await response.json()) as HealthPayload;
      if (controller.signal.aborted) return;
      setPayload(body);
      setError(null);
      setCheckedAt(new Date());
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : "Could not reach the status API.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);

  useEffect(() => {
    // Deferred by a tick, like the dashboard's first fetch: state updates do
    // not run synchronously inside the effect body.
    const first = window.setTimeout(() => {
      void load();
    }, 0);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      controllerRef.current?.abort();
    };
  }, [load]);

  const session = payload
    ? sessionLabel(payload.market_session.is_open, payload.market_session.reason)
    : "…";
  const sessionToneValue = payload ? sessionTone(payload.market_session.is_open) : "info";
  const overallTone = payload ? healthTone(payload.status) : "warn";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500 selection:text-zinc-950">
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/80 px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Dashboard
            </Link>
            <div className="flex items-center gap-2">
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-1.5 text-emerald-400">
                <HeartPulse className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-base font-bold text-zinc-100">System Status</h1>
                <p className="text-xs text-zinc-400">
                  Collector, database and snapshot freshness
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs text-zinc-400">
            {checkedAt && (
              <span className="hidden sm:inline">
                Checked{" "}
                {checkedAt.toLocaleTimeString("en-GB", {
                  timeZone: "Asia/Kolkata",
                  hour12: false,
                })}{" "}
                IST · auto every {POLL_MS / 1000}s
              </span>
            )}
            <button
              type="button"
              onClick={() => void load()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-semibold text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {error && !payload && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-3 border border-rose-900/70 bg-rose-950/30 p-4 text-sm text-rose-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Status API error</p>
              <p className="mt-1 text-rose-200/80">{error}</p>
            </div>
          </div>
        )}

        {!payload && !error && (
          <div className="animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-sm text-zinc-500">
            Reading /api/health…
          </div>
        )}

        {payload && (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Card title="Pipeline" icon={<Activity className="h-4 w-4" />}>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <Badge tone={overallTone}>
                    {HEALTH_LABEL[payload.status] ?? payload.status}
                  </Badge>
                  <span className="text-xs text-zinc-500">
                    {formatIst(payload.generated_at) ?? "—"}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">{payload.worker.note}</p>
              </Card>

              <Card title="Market Session" icon={<Clock className="h-4 w-4" />}>
                <div className="mb-2">
                  <Badge tone={sessionToneValue}>{session}</Badge>
                </div>
                <p className="text-xs leading-relaxed text-zinc-400">
                  The market calendar decides when the collector fetches. Outside a
                  session the collector idles and no rows are written.
                </p>
              </Card>

              <Card title="Database" icon={<Database className="h-4 w-4" />}>
                <Row
                  label="Reachable"
                  value={payload.database.reachable ? "Yes" : "No"}
                />
                <Row label="Snapshots stored" value={payload.database.rows} />
                <Row
                  label="Last write"
                  value={
                    <>
                      {formatIst(payload.worker.last_write_at) ?? "never"}{" "}
                      <span className="font-normal text-zinc-500">
                        ({formatAge(payload.worker.seconds_since_write)})
                      </span>
                    </>
                  }
                />
              </Card>

              <Card title="Collector" icon={<Server className="h-4 w-4" />}>
                <div className="mb-2">
                  <Badge tone={workerStateTone(payload.worker.state)}>
                    {workerStateLabel(payload.worker.state)}
                  </Badge>
                </div>
                <Row
                  label="Heartbeat"
                  value={formatAge(payload.worker.heartbeat.seconds_ago)}
                />
                <Row
                  label="Latest NSE timestamp"
                  value={payload.worker.nse_source.latest_timestamp ?? "—"}
                />
                <Row
                  label="Source age"
                  value={
                    <>
                      {formatAge(payload.worker.nse_source.source_age_seconds)}
                      {payload.worker.nse_source.freshness_status && (
                        <span className="ml-2">
                          <Badge
                            tone={symbolStatusTone(
                              payload.worker.nse_source.freshness_status,
                            )}
                          >
                            {payload.worker.nse_source.freshness_status}
                          </Badge>
                        </span>
                      )}
                    </>
                  }
                />
              </Card>
            </div>

            <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-lg">
              <table className="w-full min-w-[46rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-[11px] uppercase tracking-wider text-zinc-500">
                    <th className="px-4 py-3 font-semibold">Symbol</th>
                    <th className="px-4 py-3 font-semibold">Expiry</th>
                    <th className="px-4 py-3 text-right font-semibold">Spot</th>
                    <th className="px-4 py-3 font-semibold">NSE timestamp</th>
                    <th className="px-4 py-3 text-right font-semibold">Source age</th>
                    <th className="px-4 py-3 text-right font-semibold">Write age</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.symbols.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-zinc-500">
                        No snapshots are stored yet.
                      </td>
                    </tr>
                  )}
                  {payload.symbols.map((row) => (
                    <tr
                      key={`${row.symbol}-${row.expiry}`}
                      className="border-b border-zinc-800/60 last:border-0 hover:bg-zinc-800/30"
                    >
                      <td className="px-4 py-3 font-semibold text-zinc-100">{row.symbol}</td>
                      <td className="px-4 py-3 text-zinc-300">{row.expiry}</td>
                      <td className="px-4 py-3 text-right text-zinc-200">
                        {row.spot === null ? "—" : formatIndian(row.spot, 2)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-300">
                        {row.nse_timestamp ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-300">
                        {formatAge(row.source_age_seconds)}
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-300">
                        {formatAge(row.write_age_seconds)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={symbolStatusTone(row.status)}>{row.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {error && (
              <div
                role="status"
                className="mt-4 border border-amber-900/70 bg-amber-950/20 p-3 text-xs text-amber-200"
              >
                Live refresh failed ({error}); showing the last successful read.
              </div>
            )}

            <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">
              Reads GET /api/health only — the same public endpoint the dashboard uses.
              No database credential ever reaches this page, and nothing here is
              written back.
            </p>
          </>
        )}
      </main>

      <footer className="mt-12 border-t border-zinc-800/80 py-6 text-center text-xs text-zinc-500">
        <p>NSE Option Chain Quantitative Dashboard &copy; 2026</p>
      </footer>
    </div>
  );
}
