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

-- Allow public reads (Vercel Next.js app uses the anon public key)
CREATE POLICY "Allow public read access on live chain"
    ON public.option_chain_live FOR SELECT
    TO anon, authenticated
    USING (true);

CREATE POLICY "Allow public read access on chain history"
    ON public.option_chain_history FOR SELECT
    TO anon, authenticated
    USING (true);

-- Allow backend worker with anon key (or service_role key) to insert & update
CREATE POLICY "Allow write access for backend worker"
    ON public.option_chain_live FOR ALL
    TO anon, authenticated
    USING (true)
    WITH CHECK (true);

CREATE POLICY "Allow insert for backend worker on history"
    ON public.option_chain_history FOR INSERT
    TO anon, authenticated
    WITH CHECK (true);
