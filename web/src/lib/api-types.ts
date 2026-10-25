/** Wire types shared by the dashboard and the read-only API routes. */
import type {
  FieldGroup,
  StrikeRange,
} from "./chain-selection";
import type { FreshnessReason, SnapshotStatus } from "./market-status";
import type {
  OptionChainHistoryPoint,
  StrikeRow,
} from "@/types/option-chain";

export interface ChainMeta {
  symbol: string;
  expiry: string;
  spot: number;
  pcr: number | null;
  max_pain: number | null;
  total_ce_oi: number;
  total_pe_oi: number;
  nse_timestamp: string | null;
  snapshot_updated_at: string;
  generated_at: string;
  status: SnapshotStatus;
  market_open: boolean;
  status_reason: FreshnessReason;
  age_seconds: number | null;
  strike_count: number;
  source: string;
  strike_range: StrikeRange;
  strike_range_label: string;
  field_groups: FieldGroup[];
  fields_label: string;
  strikes_returned: number;
}

export interface ChainResponse {
  meta: ChainMeta;
  fields: string[];
  chain: StrikeRow[];
}

export interface ExpiryOption {
  expiry: string;
  nse_timestamp: string | null;
  snapshot_updated_at: string;
}

export interface ExpiriesResponse {
  symbol: string;
  generated_at: string;
  newest: string;
  expiries: ExpiryOption[];
}

export interface HistoryResponse {
  meta: {
    symbol: string;
    expiry: string;
    limit: number;
    count: number;
    generated_at: string;
    source: string;
  };
  points: OptionChainHistoryPoint[];
}

export interface ApiErrorResponse {
  error: { code: string; message: string };
}

/** What the badge shows: the snapshot status, plus transport states. */
export type UiStatus = SnapshotStatus | "Loading" | "Error";

export type RefreshMinutes = 1 | 5 | 15 | 30;

export const REFRESH_INTERVAL_OPTIONS: Array<{ value: RefreshMinutes; label: string }> = [
  { value: 1, label: "1 min" },
  { value: 5, label: "5 min" },
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
];
