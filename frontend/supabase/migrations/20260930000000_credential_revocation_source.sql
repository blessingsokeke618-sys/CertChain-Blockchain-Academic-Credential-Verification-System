BEGIN;

ALTER TABLE public.credentials
    ADD COLUMN IF NOT EXISTS revocation_source TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.credentials'::regclass
          AND conname  = 'credentials_revocation_source_check'
    ) THEN
        ALTER TABLE public.credentials
            ADD CONSTRAINT credentials_revocation_source_check
            CHECK (revocation_source IN ('issuer', 'platform'));
    END IF;
END
$$;

UPDATE public.credentials
SET    revocation_source = 'issuer'
WHERE  revoked IS TRUE
  AND  revocation_source IS NULL;

COMMIT;
