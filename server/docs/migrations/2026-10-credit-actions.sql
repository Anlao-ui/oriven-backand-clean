-- ════════════════════════════════════════════════════════════════
-- credit_actions — one row per paid user action (services/paidActions.js)
--
-- Purpose: make "one user action = at most one charge, and a failed action
-- is refunded exactly once" hold across processes and restarts, not only
-- inside one Node process.
--
--   • idempotency: UNIQUE (user_id, idempotency_key) — the same
--     X-Idempotency-Key can never start a second billable action.
--   • lane lock:   UNIQUE (user_id, lane) WHERE status = 'in_progress' —
--     at most one in-flight action per user per lane ('create-ad',
--     'research', 'video', 'chat'; 'image' uses slotted lanes image:0..N).
--   • refund once: the server only refunds after moving a row out of
--     'in_progress' / 'awaiting_async' with a conditional UPDATE, so two
--     processes can never both refund the same action.
--
-- Stores metadata only (no prompts, no generated content).
-- Safe to apply while the app runs: until this table exists the server uses
-- in-memory protection and logs "credit_actions table not found".
-- Apply in the Supabase SQL editor. Idempotent (IF NOT EXISTS).
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.credit_actions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL,
  lane             text NOT NULL,
  idempotency_key  text NOT NULL,
  route            text,
  status           text NOT NULL DEFAULT 'in_progress'
                   CHECK (status IN ('in_progress', 'succeeded', 'failed', 'refunding', 'refunded', 'refund_failed', 'awaiting_async')),
  feature_key      text,
  credits_cost     integer NOT NULL DEFAULT 0,
  charged          boolean NOT NULL DEFAULT false,
  async_job_id     text,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_actions_user_key_uidx
  ON public.credit_actions (user_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS credit_actions_user_lane_inflight_uidx
  ON public.credit_actions (user_id, lane) WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS credit_actions_status_created_idx
  ON public.credit_actions (status, created_at);

CREATE INDEX IF NOT EXISTS credit_actions_async_job_idx
  ON public.credit_actions (async_job_id) WHERE async_job_id IS NOT NULL;

-- Server-only table: RLS on, no policies → only the service role can read/write.
ALTER TABLE public.credit_actions ENABLE ROW LEVEL SECURITY;

-- Rows needing manual attention (a refund the RPC rejected):
--   SELECT * FROM public.credit_actions WHERE status = 'refund_failed';
