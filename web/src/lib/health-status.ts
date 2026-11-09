/**
 * Presentation rules for the collector status page.
 *
 * The API owns the numbers (`/api/health`); this module only turns them into
 * labels and tones the UI can render, so every mapping here is pure and unit
 * tested. Unknown values degrade to a neutral label instead of guessing.
 */
import type { SnapshotStatus } from "./market-status";

/** Overall pipeline verdict returned by `/api/health`. */
export type HealthStatus = "ok" | "degraded" | "unavailable";

/**
 * Collector write cadence:
 * `never` never wrote, `running` wrote recently, `delayed` is behind while the
 * market is open, `stalled` stopped during a session, `idle_off_hours` is the
 * expected state outside trading hours.
 */
export type WorkerState = "never" | "running" | "delayed" | "stalled" | "idle_off_hours";

/** Badge tone shared by the status page and the dashboard header. */
export type StatusTone = "good" | "info" | "warn" | "bad";

export interface HealthSymbolEntry {
  symbol: string;
  expiry: string;
  spot: number | null;
  nse_timestamp: string | null;
  snapshot_updated_at: string | null;
  source_age_seconds: number | null;
  write_age_seconds: number | null;
  status: SnapshotStatus;
  status_reason: string;
  market_open: boolean;
}

export interface HealthPayload {
  status: HealthStatus;
  generated_at: string;
  market_open: boolean;
  market_session: { is_open: boolean; reason: string };
  database: { reachable: boolean; rows: number };
  worker: {
    state: WorkerState;
    last_write_at: string | null;
    seconds_since_write: number | null;
    heartbeat: {
      status: string;
      last_seen_at: string | null;
      seconds_ago: number | null;
    };
    database_write: {
      last_write_at: string | null;
      seconds_since_write: number | null;
      write_state: string;
    };
    nse_source: {
      latest_timestamp: string | null;
      source_age_seconds: number | null;
      freshness_status: SnapshotStatus | null;
    };
    note: string;
  };
  symbols: HealthSymbolEntry[];
}

export function healthTone(status: string): StatusTone {
  if (status === "ok") return "good";
  if (status === "degraded") return "warn";
  return "bad";
}

/** Snapshot freshness badges: only "Last Close" is a calm, expected state. */
export function symbolStatusTone(status: string): StatusTone {
  if (status === "Live") return "good";
  if (status === "Last Close") return "info";
  if (status === "Stale") return "warn";
  return "bad";
}

export function workerStateLabel(state: string): string {
  switch (state) {
    case "running":
      return "Running";
    case "delayed":
      return "Delayed";
    case "stalled":
      return "Stalled";
    case "idle_off_hours":
      return "Idle (market closed)";
    case "never":
      return "No writes yet";
    default:
      return state;
  }
}

export function workerStateTone(state: string): StatusTone {
  switch (state) {
    case "running":
    case "idle_off_hours":
      return "good";
    case "delayed":
      return "warn";
    default:
      return "bad";
  }
}

const SESSION_REASON_LABELS: Record<string, string> = {
  open: "Open",
  weekend: "Closed — weekend",
  exchange_holiday: "Closed — exchange holiday",
  outside_trading_hours: "Closed — outside trading hours",
};

export function sessionLabel(isOpen: boolean, reason: string): string {
  if (isOpen) return "Open";
  return SESSION_REASON_LABELS[reason] ?? "Closed";
}

export function sessionTone(isOpen: boolean): StatusTone {
  return isOpen ? "good" : "info";
}

/**
 * Human age for a seconds count: "45s ago", "12m ago", "3h 4m ago", "2d ago".
 * Missing values are "never" — the API sends null when nothing was written.
 */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "never";
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s ago`;
  if (total < 3600) return `${Math.floor(total / 60)}m ago`;
  if (total < 86_400) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  }
  return `${Math.floor(total / 86_400)}d ago`;
}

const IST_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Format an ISO instant as IST wall-clock text; null when unparseable. */
export function formatIst(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return IST_DATE_TIME.format(new Date(parsed));
}
