-- Issue #135: persist TTL keeper outcomes for the admin statistics endpoint.

CREATE TABLE IF NOT EXISTS public.cron_run_log (
    job_name TEXT NOT NULL,
    run_id UUID NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('succeeded', 'partial', 'failed')),
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_name, run_id)
);

CREATE INDEX IF NOT EXISTS idx_cron_run_log_job_completed
    ON public.cron_run_log (job_name, completed_at DESC);

ALTER TABLE public.cron_run_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin can view cron run log" ON public.cron_run_log;
CREATE POLICY "Admin can view cron run log"
    ON public.cron_run_log FOR SELECT
    USING (public.is_admin());

COMMENT ON TABLE public.cron_run_log IS
    'Outcome log for scheduled jobs. Writes use the service-role client; '
    'admins can read run summaries.';
