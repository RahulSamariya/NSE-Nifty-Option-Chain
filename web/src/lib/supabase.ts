import { createClient } from "@supabase/supabase-js";
import { OptionChainRecord, StrikeRow } from "@/types/option-chain";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

// Indian number formatting helper: 1,05,611
export function formatIndian(val: number | string | null | undefined, decimals = 0): string {
  if (val === null || val === undefined) return "-";
  const num = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(num) || num === 0) return "-";

  const isNeg = num < 0;
  const absNum = Math.abs(num);
  const fixed = absNum.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");

  let formatted = intPart;
  if (intPart.length > 3) {
    const lastThree = intPart.substring(intPart.length - 3);
    const rest = intPart.substring(0, intPart.length - 3);
    formatted = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + lastThree;
  }

  const result = (isNeg ? "-" : "") + formatted + (decPart ? "." + decPart : "");
  return result;
}

// Generate realistic mock data for preview/development when Supabase is not connected
export function generateMockOptionChain(symbol = "NIFTY"): OptionChainRecord {
  const spot = symbol === "BANKNIFTY" ? 52400 : symbol === "FINNIFTY" ? 23900 : 24650;
  const step = symbol === "BANKNIFTY" ? 100 : 50;
  const atmBase = Math.round(spot / step) * step;

  const rows: StrikeRow[] = [];
  let totalCeOi = 0;
  let totalPeOi = 0;

  for (let i = -15; i <= 15; i++) {
    const strike = atmBase + i * step;
    const isCeItm = strike < spot;
    const isPeItm = strike > spot;

    const dist = Math.abs(strike - spot);
    const ceLtp = Math.max(5, isCeItm ? spot - strike + 40 + Math.random() * 20 : Math.max(2, 250 - dist * 0.4 + Math.random() * 15));
    const peLtp = Math.max(5, isPeItm ? strike - spot + 40 + Math.random() * 20 : Math.max(2, 250 - dist * 0.4 + Math.random() * 15));

    const ceOi = Math.round(Math.max(1000, (40000 - dist * 40) * (0.8 + Math.random() * 0.5)));
    const peOi = Math.round(Math.max(1000, (42000 - dist * 40) * (0.8 + Math.random() * 0.5)));

    totalCeOi += ceOi;
    totalPeOi += peOi;

    rows.push({
      STRIKE: strike,
      CE_OI: ceOi,
      CE_CHNG_IN_OI: Math.round((Math.random() - 0.4) * 8000),
      CE_VOLUME: Math.round(ceOi * (1.5 + Math.random())),
      CE_IV: +(12.5 + Math.abs(i) * 0.3 + (Math.random() - 0.5)).toFixed(2),
      CE_LTP: +ceLtp.toFixed(2),
      CE_CHNG: +(Math.random() * 12 - 5).toFixed(2),
      PE_OI: peOi,
      PE_CHNG_IN_OI: Math.round((Math.random() - 0.4) * 8000),
      PE_VOLUME: Math.round(peOi * (1.5 + Math.random())),
      PE_IV: +(13.1 + Math.abs(i) * 0.28 + (Math.random() - 0.5)).toFixed(2),
      PE_LTP: +peLtp.toFixed(2),
      PE_CHNG: +(Math.random() * 12 - 5).toFixed(2),
    });
  }

  const pcr = totalCeOi > 0 ? +(totalPeOi / totalCeOi).toFixed(2) : 1.0;

  return {
    symbol,
    expiry: "31-Oct-2026",
    spot,
    pcr,
    max_pain: atmBase,
    total_ce_oi: totalCeOi,
    total_pe_oi: totalPeOi,
    nse_timestamp: new Date().toLocaleTimeString("en-IN", { hour12: false }) + " IST",
    updated_at: new Date().toISOString(),
    raw_data: rows,
  };
}
