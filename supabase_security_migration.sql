-- Review and run manually against an existing Supabase project.
-- This removes anonymous writes created by the previous schema.
-- The Python worker must use SUPABASE_KEY=service_role; keep it out of Vercel.

ALTER TABLE public.option_chain_live ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.option_chain_history ENABLE ROW LEVEL SECURITY;

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

CREATE POLICY option_chain_live_public_read
    ON public.option_chain_live FOR SELECT
    TO anon
    USING (true);

CREATE POLICY option_chain_history_public_read
    ON public.option_chain_history FOR SELECT
    TO anon
    USING (true);