-- Issue #94: separate SEP-0010 login challenges from wallet-claim challenges.
-- Both are single-use nonces bound to one address, but they must never be
-- interchangeable: a claim signature must not authenticate a login and vice
-- versa.

ALTER TABLE public.wallet_claim_nonces
    ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'claim';

COMMENT ON COLUMN public.wallet_claim_nonces.purpose IS
    'Flow that issued the challenge: claim or login. Verifiers must filter on it.';

CREATE INDEX IF NOT EXISTS idx_wallet_claim_nonces_purpose
    ON public.wallet_claim_nonces (purpose, wallet_address, expires_at DESC);
