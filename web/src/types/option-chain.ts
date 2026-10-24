export interface StrikeRow {
  STRIKE: number;
  CE_OI?: number;
  CE_CHNG_IN_OI?: number;
  CE_PCHNG_IN_OI?: number;
  CE_VOLUME?: number;
  CE_IV?: number;
  CE_LTP?: number;
  CE_CHNG?: number;
  CE_PCHNG?: number;
  CE_BID?: number;
  CE_BID_QTY?: number;
  CE_ASK?: number;
  CE_ASK_QTY?: number;
  PE_OI?: number;
  PE_CHNG_IN_OI?: number;
  PE_PCHNG_IN_OI?: number;
  PE_VOLUME?: number;
  PE_IV?: number;
  PE_LTP?: number;
  PE_CHNG?: number;
  PE_PCHNG?: number;
  PE_BID?: number;
  PE_BID_QTY?: number;
  PE_ASK?: number;
  PE_ASK_QTY?: number;
}

export interface OptionChainRecord {
  symbol: string;
  expiry: string;
  spot: number;
  pcr: number | null;
  max_pain: number | null;
  total_ce_oi: number;
  total_pe_oi: number;
  nse_timestamp: string;
  updated_at: string;
  raw_data: StrikeRow[];
}

export interface OptionChainHistoryPoint {
  id: number;
  symbol: string;
  expiry: string;
  spot: number;
  pcr: number | null;
  max_pain: number | null;
  total_ce_oi: number;
  total_pe_oi: number;
  nse_timestamp: string;
  created_at: string;
}
