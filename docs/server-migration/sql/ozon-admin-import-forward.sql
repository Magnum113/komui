-- KOMUI staging Ozon admin import support.
-- Safe to apply on the self-hosted staging PostgreSQL database.

BEGIN;

CREATE TABLE IF NOT EXISTS public.merch_admin_import_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_type text NOT NULL,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  can_import boolean NOT NULL DEFAULT false,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.merch_admin_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  status text NOT NULL,
  idempotency_key text,
  preview_id uuid REFERENCES public.merch_admin_import_previews(id) ON DELETE SET NULL,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  progress_current integer NOT NULL DEFAULT 0,
  progress_total integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS merch_admin_jobs_idempotency_key_idx
  ON public.merch_admin_jobs(job_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

GRANT SELECT, INSERT ON public.merch_admin_import_previews TO komui_app;
GRANT SELECT, INSERT, UPDATE ON public.merch_admin_jobs TO komui_app;

COMMIT;
