-- ════════════════════════════════════════════════════════════════
-- 2026-10 — Access periods, one-time purchases and the credit ledger
--
-- Replaces the plan-tier subscription model for NEW customers with five
-- access periods bought once (Flex 14 days, Monthly, Quarterly, Semi-Annual,
-- Annual; services/pricing.js), renewed manually. Legacy Stripe
-- subscriptions keep working for the customers who have one.
--
-- What this adds (additive; nothing is dropped, no customer row is deleted):
--   profiles.access_expires_at   the one time-based access check
--   profiles.access_plan         the plan of the latest purchase (display)
--   purchases                    one row per checkout (pending → paid / failed /
--                                expired / refunded / partially_refunded /
--                                disputed / dispute_won)
--   credit_grants                the credit schedule of a purchase (instalments)
--   credit_ledger                every balance change that isn't a paid action:
--                                grants, expiry, revocations, legacy cycles
--   fulfill_purchase()           pay → access + first instalment, atomically, once
--   grant_due_credit_instalments() / expire_access() / revoke_purchase()
--   spend_credits()              same signature; free daily top-up removed and
--                                spending requires active access
--   ensure_free_daily_cycle()    now a no-op (the free plan is retired)
--
-- Existing customers (the legacy transition, at the end of this file):
--   • Nothing is guessed from credits_cycle_end or from a Stripe
--     subscription id being present. Every legacy subscriber
--     (starter/creator/professional) gets an explicit, auditable row in
--     legacy_entitlements:
--       kind 'stripe_subscription' (has a Stripe subscription id) →
--         status 'needs_review' until the backend has asked Stripe;
--       kind 'manual' (no Stripe subscription, e.g. a manually granted
--         Professional plan) → status 'active', no end date.
--     While an entitlement is active or needs review, access continues:
--     spending is allowed, the expiry job never ends the account and never
--     sets its credits to 0, and access_expires_at is kept at least 7 days
--     ahead (refresh_legacy_entitlements, run by the backend's access job).
--     An entitlement ends only by an explicit decision
--     (update_legacy_entitlement): Stripe confirming the subscription ended,
--     or an end date set by an admin. No customer-specific date is invented.
--   • Free accounts keep their balance exactly as it is. The free daily
--     top-up stops; the balance is not deleted, never expires (free accounts
--     have no access period) and is kept when the account buys a plan.
--   • legacy_transition_snapshot records every profile's state before the
--     transition, and the migration aborts if any balance changed.
--
-- Run in the Supabase SQL editor as ONE run: the file is a single
-- transaction (BEGIN … COMMIT) — it applies completely or not at all.
-- Rollback: 2026-10-access-purchases-rollback.sql (restores the previous
-- functions and permissions; keeps the new tables and their records).
-- ════════════════════════════════════════════════════════════════

BEGIN;

-- Guard: fulfill_purchase writes subscription_status = 'paid' and the expiry
-- writes 'free'. If production constrains that column (a CHECK or an enum)
-- so that 'paid' is refused, every purchase would fail AFTER payment — so
-- abort now, before anything changes. Checked on an empty copy of the
-- table's definition (only the constraints on subscription_status); no
-- customer row is read or touched.
DO $$
DECLARE c text;
BEGIN
  CREATE TEMP TABLE _profiles_probe (LIKE public.profiles INCLUDING CONSTRAINTS);
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'pg_temp._profiles_probe'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) NOT ILIKE '%subscription_status%' LOOP
    EXECUTE format('ALTER TABLE pg_temp._profiles_probe DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT attname FROM pg_attribute WHERE attrelid = 'pg_temp._profiles_probe'::regclass AND attnum > 0 AND NOT attisdropped AND attnotnull LOOP
    EXECUTE format('ALTER TABLE pg_temp._profiles_probe ALTER COLUMN %I DROP NOT NULL', c);
  END LOOP;
  INSERT INTO pg_temp._profiles_probe (subscription_status) VALUES ('paid'), ('free');
  DROP TABLE pg_temp._profiles_probe;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'access purchases: profiles.subscription_status must accept ''paid'' and ''free'' (%) — nothing applied', SQLERRM;
END $$;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS access_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS access_plan text;

CREATE INDEX IF NOT EXISTS profiles_access_expires_idx ON public.profiles (access_expires_at) WHERE access_expires_at IS NOT NULL;

-- ── purchases ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchases (
  id                          uuid PRIMARY KEY,
  user_id                     uuid NOT NULL REFERENCES public.profiles(id),
  plan_id                     text NOT NULL CHECK (plan_id IN ('flex', 'monthly', 'quarterly', 'semiannual', 'annual')),
  status                      text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded', 'disputed', 'dispute_won')),
  -- the terms fixed at checkout (copied from services/pricing.js), so a later
  -- price change never alters what a customer bought
  price_incl_vat_cents        integer NOT NULL CHECK (price_incl_vat_cents > 0),
  currency                    text NOT NULL DEFAULT 'eur',
  duration_months             integer NOT NULL DEFAULT 0 CHECK (duration_months >= 0),
  duration_days               integer NOT NULL DEFAULT 0 CHECK (duration_days >= 0),
  credits_total               integer NOT NULL CHECK (credits_total > 0),
  instalments                 integer NOT NULL CHECK (instalments >= 1),
  -- what Stripe reported when the payment was confirmed
  amount_total_cents          integer,
  amount_tax_cents            integer,
  stripe_checkout_session_id  text UNIQUE,
  stripe_price_id             text,          -- the plan's Stripe Price (services/pricing.js STRIPE_PRICE_IDS)
  stripe_product_id           text,          -- that price's product
  stripe_payment_intent_id    text UNIQUE,
  stripe_customer_id          text,
  access_start                timestamptz,
  access_end                  timestamptz,
  failure_reason              text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  paid_at                     timestamptz,
  refunded_at                 timestamptz,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (duration_months > 0 OR duration_days > 0),
  CHECK (credits_total % instalments = 0)
);
-- Added with the Stripe Price IDs: safe to re-run on a table created earlier.
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS stripe_price_id text, ADD COLUMN IF NOT EXISTS stripe_product_id text;
CREATE INDEX IF NOT EXISTS purchases_user_idx ON public.purchases (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS purchases_pending_idx ON public.purchases (user_id) WHERE status = 'pending';

-- ── credit_grants: the credit schedule of a purchase ────────────
CREATE TABLE IF NOT EXISTS public.credit_grants (
  id           bigserial PRIMARY KEY,
  purchase_id  uuid NOT NULL REFERENCES public.purchases(id),
  user_id      uuid NOT NULL,
  instalment   integer NOT NULL CHECK (instalment >= 0),
  credits      integer NOT NULL CHECK (credits > 0),
  grant_at     timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'granted', 'cancelled')),
  granted_at   timestamptz,
  UNIQUE (purchase_id, instalment)
);
CREATE INDEX IF NOT EXISTS credit_grants_due_idx ON public.credit_grants (grant_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS credit_grants_user_idx ON public.credit_grants (user_id);

-- ── credit_ledger: balance changes that aren't paid actions ─────
-- (paid actions stay in credit_transactions / credit_actions)
CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id             bigserial PRIMARY KEY,
  user_id        uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('grant', 'expire', 'revoke', 'legacy_cycle')),
  delta          integer NOT NULL,
  balance_after  integer NOT NULL,
  purchase_id    uuid,
  grant_id       bigint,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON public.credit_ledger (user_id, created_at DESC);

-- ── legacy_entitlements: access of existing (pre-purchase) customers ──
-- One row per legacy subscriber. 'active' and 'needs_review' both keep
-- access (and the balance) — needs_review means a person or the Stripe check
-- still has to confirm it. ends_at NULL = no end decided. Only
-- update_legacy_entitlement changes a row (backend / admin, service role).
CREATE TABLE IF NOT EXISTS public.legacy_entitlements (
  user_id                 uuid PRIMARY KEY REFERENCES public.profiles(id),
  kind                    text NOT NULL CHECK (kind IN ('stripe_subscription', 'manual')),
  plan                    text NOT NULL,
  status                  text NOT NULL CHECK (status IN ('active', 'needs_review', 'ended')),
  stripe_subscription_id  text,
  ends_at                 timestamptz,
  reason                  text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  ended_at                timestamptz,
  CHECK (status <> 'ended' OR ended_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS legacy_entitlements_open_idx ON public.legacy_entitlements (status) WHERE status <> 'ended';

-- ── legacy_transition_snapshot: every profile as it was, once ───
-- Written by the transition below (first run only; re-runs keep the
-- original). The audit trail of what each account had before the change.
CREATE TABLE IF NOT EXISTS public.legacy_transition_snapshot (
  user_id                  uuid PRIMARY KEY,
  subscription_status      text,
  credits_balance          integer,
  credits_cycle_end        timestamptz,
  had_stripe_subscription  boolean NOT NULL,
  classification           text NOT NULL CHECK (classification IN ('legacy_stripe', 'legacy_manual', 'free_with_credits', 'free_no_credits', 'other')),
  snapshot_at              timestamptz NOT NULL DEFAULT now()
);

-- Backend-only: the app reads and writes these through the backend (service
-- role, which bypasses RLS); the browser never queries them directly
-- (frontend checked 2026-11-05). RLS stays on with own-row read policies as
-- a second barrier, but browsers hold no privilege at all — consistent with
-- 2026-11-browser-write-lockdown.sql, so re-running this file after the
-- lockdown reopens nothing.
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_transition_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.purchases, public.credit_grants, public.credit_ledger, public.legacy_entitlements, public.legacy_transition_snapshot FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.credit_grants_id_seq, public.credit_ledger_id_seq FROM anon, authenticated;
GRANT ALL ON public.purchases, public.credit_grants, public.credit_ledger, public.legacy_entitlements, public.legacy_transition_snapshot TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.credit_grants_id_seq, public.credit_ledger_id_seq TO service_role;
DROP POLICY IF EXISTS purchases_select_own ON public.purchases;
CREATE POLICY purchases_select_own ON public.purchases FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS credit_grants_select_own ON public.credit_grants;
CREATE POLICY credit_grants_select_own ON public.credit_grants FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS credit_ledger_select_own ON public.credit_ledger;
CREATE POLICY credit_ledger_select_own ON public.credit_ledger FOR SELECT USING (auth.uid() = user_id);

-- ── helper: does a legacy entitlement still protect this account? ──
CREATE OR REPLACE FUNCTION _legacy_protected(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM legacy_entitlements e
                  WHERE e.user_id = p_user_id AND e.status IN ('active', 'needs_review')
                    AND (e.ends_at IS NULL OR e.ends_at > now()));
$$;

-- ── helper: zero a profile whose access has ended (caller holds the row lock) ──
-- Never for an account a legacy entitlement still protects: nothing changes.
CREATE OR REPLACE FUNCTION _end_access(p_user_id uuid, p_note text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_bal integer;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION '_end_access: service role only'; END IF;
  IF _legacy_protected(p_user_id) THEN RETURN 0; END IF;
  SELECT credits_balance INTO v_bal FROM profiles WHERE id = p_user_id;
  -- Always recorded, also with nothing left: every credit granted before
  -- this moment is gone, which revoke_purchase relies on (it must never
  -- take an expired purchase's credits out of a newer purchase).
  INSERT INTO credit_ledger (user_id, kind, delta, balance_after, note) VALUES (p_user_id, 'expire', -COALESCE(v_bal, 0), 0, p_note);
  UPDATE profiles SET credits_balance = 0, subscription_status = 'free' WHERE id = p_user_id;
  UPDATE credit_grants SET status = 'cancelled' WHERE user_id = p_user_id AND status = 'scheduled';
  RETURN COALESCE(v_bal, 0);
END; $$;

-- ── fulfill_purchase: a CONFIRMED payment → access + first instalment ──
-- Idempotent: a purchase is fulfilled at most once (row lock + status), so a
-- retried webhook, the checkout-return sync and an async-payment event can
-- all call it safely. Refuses a payment whose amount or currency doesn't
-- match the terms fixed at checkout.
CREATE OR REPLACE FUNCTION fulfill_purchase(
  p_purchase_id uuid, p_session_id text, p_payment_intent text, p_customer text,
  p_amount_total integer, p_amount_tax integer, p_currency text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  pu purchases%ROWTYPE;
  v_exp timestamptz; v_bal integer; v_status text;
  v_start timestamptz; v_end timestamptz; v_per integer; v_grant bigint; i integer;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'fulfill_purchase: service role only'; END IF;
  SELECT * INTO pu FROM purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_purchase'); END IF;
  IF pu.status IN ('paid', 'refunded', 'partially_refunded', 'disputed', 'dispute_won') THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', pu.status, 'access_end', pu.access_end);
  END IF;
  IF p_currency IS NULL OR lower(p_currency) <> pu.currency THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'currency_mismatch');
  END IF;
  IF p_amount_total IS NULL OR p_amount_total <> pu.price_incl_vat_cents THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_mismatch');
  END IF;

  SELECT access_expires_at, credits_balance, subscription_status INTO v_exp, v_bal, v_status FROM profiles WHERE id = pu.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_profile'); END IF;
  -- Credits of an access that already ended expire first, so they never carry
  -- into a new period (the expiry job may not have run yet).
  IF v_exp IS NOT NULL AND v_exp <= now() THEN PERFORM _end_access(pu.user_id, 'expired before new purchase'); END IF;

  -- Manual renewal before expiry extends access: the new period starts when
  -- the current one ends, never overlapping it.
  v_start := GREATEST(now(), COALESCE(v_exp, now()));
  v_end := v_start + make_interval(months => pu.duration_months, days => pu.duration_days);
  v_per := pu.credits_total / pu.instalments;

  FOR i IN 0 .. pu.instalments - 1 LOOP
    INSERT INTO credit_grants (purchase_id, user_id, instalment, credits, grant_at)
      VALUES (pu.id, pu.user_id, i, v_per, CASE WHEN i = 0 THEN now() ELSE v_start + make_interval(months => i) END)
      ON CONFLICT (purchase_id, instalment) DO NOTHING;
  END LOOP;

  UPDATE credit_grants SET status = 'granted', granted_at = now()
    WHERE purchase_id = pu.id AND instalment = 0 AND status = 'scheduled' RETURNING id INTO v_grant;
  UPDATE profiles SET
      credits_balance = credits_balance + CASE WHEN v_grant IS NULL THEN 0 ELSE v_per END,
      access_expires_at = v_end, access_plan = pu.plan_id, subscription_status = 'paid'
    WHERE id = pu.user_id RETURNING credits_balance INTO v_bal;
  IF v_grant IS NOT NULL THEN
    INSERT INTO credit_ledger (user_id, kind, delta, balance_after, purchase_id, grant_id, note)
      VALUES (pu.user_id, 'grant', v_per, v_bal, pu.id, v_grant, pu.plan_id || ' instalment 1/' || pu.instalments);
  END IF;

  UPDATE purchases SET status = 'paid', paid_at = now(), updated_at = now(), access_start = v_start, access_end = v_end,
      stripe_checkout_session_id = COALESCE(stripe_checkout_session_id, p_session_id),
      stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, p_payment_intent),
      stripe_customer_id = COALESCE(stripe_customer_id, p_customer),
      amount_total_cents = p_amount_total, amount_tax_cents = p_amount_tax, failure_reason = NULL
    WHERE id = pu.id;

  RETURN jsonb_build_object('ok', true, 'fulfilled', true, 'user_id', pu.user_id, 'plan_id', pu.plan_id,
    'access_start', v_start, 'access_end', v_end, 'credits_granted', v_per, 'balance', v_bal);
END; $$;

-- ── grant_due_credit_instalments: monthly instalments of longer plans ──
-- Each due instalment is granted once (row lock + status); an instalment of a
-- purchase that is no longer paid, or of an account without access, is
-- cancelled instead. Safe to run concurrently and repeatedly.
CREATE OR REPLACE FUNCTION grant_due_credit_instalments(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE g record; v_bal integer; n integer := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'grant_due_credit_instalments: service role only'; END IF;
  FOR g IN
    SELECT cg.id, cg.user_id, cg.purchase_id, cg.credits, cg.instalment, pu.status AS purchase_status, pu.instalments, pu.plan_id
      FROM credit_grants cg JOIN purchases pu ON pu.id = cg.purchase_id
      WHERE cg.status = 'scheduled' AND cg.grant_at <= now()
      ORDER BY cg.grant_at LIMIT p_limit
      FOR UPDATE OF cg SKIP LOCKED
  LOOP
    IF g.purchase_status NOT IN ('paid', 'partially_refunded') THEN
      UPDATE credit_grants SET status = 'cancelled' WHERE id = g.id;
      CONTINUE;
    END IF;
    UPDATE profiles SET credits_balance = credits_balance + g.credits
      WHERE id = g.user_id AND access_expires_at > now() RETURNING credits_balance INTO v_bal;
    IF FOUND THEN
      UPDATE credit_grants SET status = 'granted', granted_at = now() WHERE id = g.id;
      INSERT INTO credit_ledger (user_id, kind, delta, balance_after, purchase_id, grant_id, note)
        VALUES (g.user_id, 'grant', g.credits, v_bal, g.purchase_id, g.id, g.plan_id || ' instalment ' || (g.instalment + 1) || '/' || g.instalments);
      n := n + 1;
    ELSE
      UPDATE credit_grants SET status = 'cancelled' WHERE id = g.id;
    END IF;
  END LOOP;
  RETURN n;
END; $$;

-- ── expire_access: credits expire with access ───────────────────
CREATE OR REPLACE FUNCTION expire_access(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE p record; n integer := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'expire_access: service role only'; END IF;
  FOR p IN
    SELECT id FROM profiles
      WHERE access_expires_at IS NOT NULL AND access_expires_at <= now()
        AND (credits_balance <> 0 OR subscription_status IS DISTINCT FROM 'free')
        AND NOT _legacy_protected(id)
      ORDER BY access_expires_at LIMIT p_limit
      FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM _end_access(p.id, 'access ended');
    n := n + 1;
  END LOOP;
  RETURN n;
END; $$;

-- ── revoke_purchase: full refund or dispute ─────────────────────
-- Removes what the purchase still gives: its scheduled instalments, the part
-- of its access that hasn't been used yet, and its credits that are still in
-- the balance. Credits are spent oldest first, so the balance belongs to the
-- newest grants: only this purchase's share of it is removed — never a newer
-- purchase's credits, never credits that already expired, and nothing
-- already spent is taken back from another purchase. Later purchases stacked
-- behind it move forward by the same amount, so they keep their full length.
-- Idempotent.
CREATE OR REPLACE FUNCTION revoke_purchase(p_purchase_id uuid, p_status text, p_note text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  pu purchases%ROWTYPE; v_exp timestamptz; v_bal integer;
  v_remove integer := 0; v_left integer; v_take integer; v_since timestamptz; g record;
  v_unused interval; v_new_exp timestamptz;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'revoke_purchase: service role only'; END IF;
  IF p_status NOT IN ('refunded', 'disputed') THEN RAISE EXCEPTION 'revoke_purchase: status must be refunded or disputed'; END IF;
  SELECT * INTO pu FROM purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_purchase'); END IF;
  IF pu.status NOT IN ('paid', 'partially_refunded') THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'status', pu.status);
  END IF;

  SELECT access_expires_at, credits_balance INTO v_exp, v_bal FROM profiles WHERE id = pu.user_id FOR UPDATE;
  -- This purchase's share of the balance. Only grants made since the
  -- account's last expiry can still be in it (an expiry empties the balance;
  -- >= because a purchase made after access ended expires the old balance and
  -- grants in the same transaction, same now()). Walking them newest first,
  -- the balance is assigned to the newest grants (credits are spent oldest
  -- first); what lands on this purchase's grants is what it still gives.
  v_since := COALESCE((SELECT MAX(created_at) FROM credit_ledger WHERE user_id = pu.user_id AND kind = 'expire'), '-infinity'::timestamptz);
  v_left := GREATEST(COALESCE(v_bal, 0), 0);
  FOR g IN SELECT purchase_id, credits FROM credit_grants
      WHERE user_id = pu.user_id AND status = 'granted' AND granted_at >= v_since
      ORDER BY granted_at DESC, id DESC
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := LEAST(g.credits, v_left);
    IF g.purchase_id = pu.id THEN v_remove := v_remove + v_take; END IF;
    v_left := v_left - v_take;
  END LOOP;
  UPDATE credit_grants SET status = 'cancelled' WHERE purchase_id = pu.id AND status = 'scheduled';

  v_unused := GREATEST(pu.access_end - GREATEST(now(), pu.access_start), interval '0');
  v_new_exp := v_exp - v_unused;
  -- later purchases (stacked renewals) keep their full length
  UPDATE credit_grants SET grant_at = GREATEST(now(), grant_at - v_unused)
    WHERE status = 'scheduled' AND purchase_id IN (SELECT id FROM purchases WHERE user_id = pu.user_id AND status IN ('paid', 'partially_refunded') AND id <> pu.id AND access_start >= pu.access_end);
  UPDATE purchases SET access_start = access_start - v_unused, access_end = access_end - v_unused, updated_at = now()
    WHERE user_id = pu.user_id AND status IN ('paid', 'partially_refunded') AND id <> pu.id AND access_start >= pu.access_end;

  UPDATE profiles SET credits_balance = credits_balance - v_remove, access_expires_at = v_new_exp
    WHERE id = pu.user_id RETURNING credits_balance INTO v_bal;
  IF v_remove > 0 THEN
    INSERT INTO credit_ledger (user_id, kind, delta, balance_after, purchase_id, note)
      VALUES (pu.user_id, 'revoke', -v_remove, v_bal, pu.id, p_status || COALESCE(': ' || p_note, ''));
  END IF;
  IF v_new_exp IS NULL OR v_new_exp <= now() THEN PERFORM _end_access(pu.user_id, 'access ended by ' || p_status); END IF;

  UPDATE purchases SET status = p_status, refunded_at = now(), updated_at = now() WHERE id = pu.id;
  RETURN jsonb_build_object('ok', true, 'revoked', true, 'credits_removed', v_remove, 'access_expires_at', v_new_exp);
END; $$;

-- ── spend_credits: same signature, no free top-up, access required ──
CREATE OR REPLACE FUNCTION spend_credits(
  p_user_id uuid,
  p_amount integer,
  p_free_allowance integer DEFAULT 0,
  p_free_cycle_days integer DEFAULT 1
)
RETURNS TABLE(ok boolean, balance integer) LANGUAGE plpgsql AS $$
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'spend_credits: p_amount must be greater than 0 (got %)', p_amount;
  END IF;
  IF auth.role() <> 'service_role' AND (auth.uid() IS NULL OR auth.uid() <> p_user_id) THEN
    RAISE EXCEPTION 'spend_credits: caller may only spend their own credits';
  END IF;
  -- One atomic conditional update: concurrent requests can never spend more
  -- than the balance, and nothing is spent without active access.
  UPDATE profiles SET credits_balance = credits_balance - p_amount
    WHERE id = p_user_id AND credits_balance >= p_amount
      AND subscription_status IN ('paid', 'starter', 'creator', 'professional')
      AND (access_expires_at > now() OR _legacy_protected(p_user_id));
  IF FOUND THEN
    RETURN QUERY SELECT true, profiles.credits_balance FROM profiles WHERE id = p_user_id;
  ELSE
    RETURN QUERY SELECT false, CASE WHEN (profiles.access_expires_at > now() OR _legacy_protected(p_user_id)) AND profiles.subscription_status IN ('paid', 'starter', 'creator', 'professional') THEN profiles.credits_balance ELSE 0 END FROM profiles WHERE id = p_user_id;
  END IF;
END; $$;

-- ── refresh_legacy_entitlements: keep protected accounts' access ahead ──
-- Run by the backend's access job (every 10 minutes). Ends entitlements whose
-- decided end date has passed; for every protected account moves
-- access_expires_at to at least 7 days ahead (never beyond a decided
-- ends_at, never backwards). Returns the number of accounts touched.
CREATE OR REPLACE FUNCTION refresh_legacy_entitlements()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer := 0; m integer := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'refresh_legacy_entitlements: service role only'; END IF;
  UPDATE legacy_entitlements SET status = 'ended', ended_at = now(), updated_at = now(),
         reason = COALESCE(reason || '; ', '') || 'end date reached'
   WHERE status IN ('active', 'needs_review') AND ends_at IS NOT NULL AND ends_at <= now();
  GET DIAGNOSTICS m = ROW_COUNT;
  UPDATE profiles p
     SET access_expires_at = LEAST(now() + interval '7 days', COALESCE(e.ends_at, 'infinity'::timestamptz)),
         access_plan = COALESCE(p.access_plan, e.plan)
    FROM legacy_entitlements e
   WHERE e.user_id = p.id AND e.status IN ('active', 'needs_review') AND (e.ends_at IS NULL OR e.ends_at > now())
     AND (p.access_expires_at IS NULL OR p.access_expires_at < LEAST(now() + interval '6 days', COALESCE(e.ends_at, 'infinity'::timestamptz)));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n + m;
END; $$;

-- ── update_legacy_entitlement: the one way a legacy entitlement changes ──
-- p_status: 'active' (verified), 'needs_review' (keep access, check by hand)
-- or 'ended' (stop protecting; from then on access_expires_at applies, and
-- the expiry job ends the account when it has passed). p_ends_at: a decided
-- end date (NULL = none). Every change is kept in reason with a timestamp.
CREATE OR REPLACE FUNCTION update_legacy_entitlement(p_user_id uuid, p_status text, p_ends_at timestamptz, p_reason text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e legacy_entitlements%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'update_legacy_entitlement: service role only'; END IF;
  IF p_status NOT IN ('active', 'needs_review', 'ended') THEN RAISE EXCEPTION 'update_legacy_entitlement: unknown status %', p_status; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN RAISE EXCEPTION 'update_legacy_entitlement: a reason is required'; END IF;
  SELECT * INTO e FROM legacy_entitlements WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_legacy_entitlement'); END IF;
  IF e.status = 'ended' THEN RETURN jsonb_build_object('ok', true, 'already', true, 'status', 'ended'); END IF;
  UPDATE legacy_entitlements
     SET status = p_status, ends_at = p_ends_at, updated_at = now(),
         ended_at = CASE WHEN p_status = 'ended' THEN now() ELSE NULL END,
         reason = COALESCE(reason || '; ', '') || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' ' || p_status || ': ' || p_reason
   WHERE user_id = p_user_id;
  RETURN jsonb_build_object('ok', true, 'status', p_status, 'ends_at', p_ends_at);
END; $$;

-- The free plan is retired: no daily credits for anyone.
CREATE OR REPLACE FUNCTION ensure_free_daily_cycle(
  p_user_id uuid, p_allowance integer DEFAULT 0, p_cycle_days integer DEFAULT 1
)
RETURNS TABLE(balance integer, cycle_end timestamptz, reset boolean) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT profiles.credits_balance, profiles.credits_cycle_end, false FROM profiles WHERE id = p_user_id;
END; $$;

-- ── Who may execute these functions ─────────────────────────────
-- Only the backend (service_role). Supabase grants EXECUTE on new functions
-- to anon and authenticated by default (not only via PUBLIC), so both
-- browser roles are revoked explicitly, as in the 2026-08 credit migrations.
-- All of these run as SECURITY INVOKER: _end_access, called from
-- fulfill_purchase / expire_access / revoke_purchase, is checked against the
-- caller, so service_role needs EXECUTE on it too.
REVOKE ALL ON FUNCTION _legacy_protected(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION refresh_legacy_entitlements() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION update_legacy_entitlement(uuid, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _legacy_protected(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION refresh_legacy_entitlements() TO service_role;
GRANT EXECUTE ON FUNCTION update_legacy_entitlement(uuid, text, timestamptz, text) TO service_role;
REVOKE ALL ON FUNCTION _end_access(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fulfill_purchase(uuid, text, text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION grant_due_credit_instalments(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION expire_access(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION revoke_purchase(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION spend_credits(uuid, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ensure_free_daily_cycle(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _end_access(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION fulfill_purchase(uuid, text, text, text, integer, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION grant_due_credit_instalments(integer) TO service_role;
GRANT EXECUTE ON FUNCTION expire_access(integer) TO service_role;
GRANT EXECUTE ON FUNCTION revoke_purchase(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION spend_credits(uuid, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION ensure_free_daily_cycle(uuid, integer, integer) TO service_role;

-- ── Legacy transition (existing customers) ──────────────────────
-- 1. Snapshot every profile as it is now (first run only).
INSERT INTO legacy_transition_snapshot (user_id, subscription_status, credits_balance, credits_cycle_end, had_stripe_subscription, classification)
SELECT id, subscription_status, credits_balance, credits_cycle_end, stripe_subscription_id IS NOT NULL,
       CASE WHEN subscription_status IN ('starter', 'creator', 'professional') AND stripe_subscription_id IS NOT NULL THEN 'legacy_stripe'
            WHEN subscription_status IN ('starter', 'creator', 'professional') THEN 'legacy_manual'
            WHEN COALESCE(subscription_status, 'free') = 'free' AND COALESCE(credits_balance, 0) > 0 THEN 'free_with_credits'
            WHEN COALESCE(subscription_status, 'free') = 'free' THEN 'free_no_credits'
            ELSE 'other' END
  FROM profiles
ON CONFLICT (user_id) DO NOTHING;

-- 2. An explicit entitlement for every legacy subscriber (never guessed
--    from credits_cycle_end; a Stripe id alone proves nothing → needs_review).
INSERT INTO legacy_entitlements (user_id, kind, plan, status, stripe_subscription_id, reason)
SELECT id,
       CASE WHEN stripe_subscription_id IS NOT NULL THEN 'stripe_subscription' ELSE 'manual' END,
       subscription_status,
       CASE WHEN stripe_subscription_id IS NOT NULL THEN 'needs_review' ELSE 'active' END,
       stripe_subscription_id,
       CASE WHEN stripe_subscription_id IS NOT NULL
            THEN 'transition: Stripe subscription not yet verified with Stripe; access kept until verified'
            ELSE 'transition: plan without Stripe subscription (manual grant); access kept until an end date is decided' END
  FROM profiles
 WHERE subscription_status IN ('starter', 'creator', 'professional')
ON CONFLICT (user_id) DO NOTHING;

-- 3. Their access: at least 7 days ahead, kept there by
--    refresh_legacy_entitlements. Only ever moves access forward.
UPDATE profiles p
   SET access_expires_at = GREATEST(COALESCE(p.access_expires_at, now()), now() + interval '7 days'),
       access_plan = COALESCE(p.access_plan, p.subscription_status)
  FROM legacy_entitlements e
 WHERE e.user_id = p.id AND e.status IN ('active', 'needs_review');

-- 4. Safety check: the transition changes no credit balance and no plan.
--    Any difference aborts the whole migration (nothing is applied).
DO $$
DECLARE v_changed integer;
BEGIN
  SELECT count(*) INTO v_changed
    FROM legacy_transition_snapshot s JOIN profiles p ON p.id = s.user_id
   WHERE s.snapshot_at = now()   -- rows written by THIS run (now() is fixed per transaction);
                                 -- on a re-run, balances may have changed through normal use since
     AND (p.credits_balance IS DISTINCT FROM s.credits_balance
          OR p.subscription_status IS DISTINCT FROM s.subscription_status);
  IF v_changed > 0 THEN
    RAISE EXCEPTION 'legacy transition: % profile(s) changed balance or plan — migration aborted, nothing applied', v_changed;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
