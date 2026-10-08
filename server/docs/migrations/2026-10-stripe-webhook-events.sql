-- ════════════════════════════════════════════════════════════════
-- stripe_webhook_events — each Stripe event id is processed once
-- (services/stripeBilling.js claimEvent / finishEvent)
--
-- Stripe delivers webhooks at least once, so the same event can arrive
-- again (retries, replays). The server inserts the event id before
-- processing; a second delivery of an already-processed id is acknowledged
-- without running again. A failed attempt is marked 'failed' and is
-- processed again on Stripe's retry.
--
-- Stores only the Stripe event id, type and processing status (no payload,
-- no customer data). Safe to apply while the app runs: without this table
-- the server still processes every event and relies on state-based
-- idempotency (plan derived from Stripe, credit grants keyed on the
-- billing period). Idempotent (IF NOT EXISTS). Touches no existing table.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  id          text PRIMARY KEY,                 -- Stripe event id (evt_...)
  type        text NOT NULL,
  status      text NOT NULL DEFAULT 'processing'
              CHECK (status IN ('processing', 'processed', 'failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_status_idx
  ON public.stripe_webhook_events (status, updated_at);

-- Server-only table: RLS on, no policies → only the service role can read/write.
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
