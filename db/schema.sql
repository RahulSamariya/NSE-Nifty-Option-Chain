-- ==============================================================
-- Supabase Schema for NSE Option Chain Web App
-- Paste this entire file into Supabase -> SQL Editor -> Run
-- ==============================================================

-- 1. Live Snapshot Table (Keeps only 1 active row per symbol/expiry)
CREATE TABLE IF NOT EXISTS public.option_chain_live (
    symbol TEXT NOT NULL,
    expiry TEXT NOT NULL,
    spot NUMERIC,
    pcr NUMERIC,
    max_pain NUMERIC,
    total_ce_oi NUMERIC,
    total_pe_oi NUMERIC,
    nse_timestamp TEXT,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    raw_data JSONB NOT NULL,
    PRIMARY KEY (symbol, expiry)
);

-- 2. Intraday History Table (Lightweight snapshots sampled every 5 mins)
CREATE TABLE IF NOT EXISTS public.option_chain_history (
    id BIGSERIAL PRIMARY KEY,
    symbol TEXT NOT NULL,
    expiry TEXT NOT NULL,
    spot NUMERIC,
    pcr NUMERIC,
    max_pain NUMERIC,
    total_ce_oi NUMERIC,
    total_pe_oi NUMERIC,
    nse_timestamp TEXT,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Indexes for lightning fast queries
CREATE INDEX IF NOT EXISTS idx_history_lookup 
    ON public.option_chain_history(symbol, expiry, created_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.option_chain_live ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.option_chain_history ENABLE ROW LEVEL SECURITY;

-- Remove older policies when this schema is reapplied.
DROP POLICY IF EXISTS "Allow write access for backend worker" ON public.option_chain_live;
DROP POLICY IF EXISTS "Allow insert for backend worker on history" ON public.option_chain_history;
DROP POLICY IF EXISTS "Allow public read access on live chain" ON public.option_chain_live;
DROP POLICY IF EXISTS "Allow public read access on chain history" ON public.option_chain_history;
DROP POLICY IF EXISTS option_chain_live_public_read ON public.option_chain_live;
DROP POLICY IF EXISTS option_chain_history_public_read ON public.option_chain_history;

REVOKE ALL PRIVILEGES ON TABLE public.option_chain_live FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.option_chain_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.option_chain_live TO anon;
GRANT SELECT ON TABLE public.option_chain_history TO anon;
GRANT ALL PRIVILEGES ON TABLE public.option_chain_live TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.option_chain_history TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.option_chain_history_id_seq TO service_role;

-- Vercel uses the anon key for reads. The trusted worker uses the backend-only
-- service_role key, which bypasses RLS.
CREATE POLICY option_chain_live_public_read
    ON public.option_chain_live FOR SELECT
    TO anon
    USING (true);

CREATE POLICY option_chain_history_public_read
    ON public.option_chain_history FOR SELECT
    TO anon
    USING (true);
