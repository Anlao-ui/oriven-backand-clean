-- ════════════════════════════════════════════════════════════════
-- Entitlement check — READ ONLY. Run in the Supabase SQL editor before
-- deploying the entitlement routing (services/entitlement.js).
-- Changes nothing: SELECT statements only.
--
-- The rule the server applies (services/entitlement.js):
--   active   access_expires_at > now()                      → the app
--   expired  access_expires_at <= now()                     → the plans
--   none     access_expires_at IS NULL → new account: onboarding,
--            older free account (before the onboarding rollout or
--            onboarding completed): the app with its existing limits
-- ════════════════════════════════════════════════════════════════

-- 1. How many accounts land where (deleted / tombstoned profiles excluded).
SELECT CASE
         WHEN p.access_expires_at > now()  THEN 'active → app'
         WHEN p.access_expires_at <= now() THEN 'expired → plans'
         ELSE 'never paid'
       END AS entitlement,
       COUNT(*) AS accounts
  FROM public.profiles p
 GROUP BY 1
 ORDER BY 1;

-- 2. A paying label without an end date: NO paid access today either
--    (pricing.hasAccess already requires access_expires_at). Should be empty;
--    any row here is a manual edit or a legacy case to look at by hand.
SELECT p.id, p.subscription_status, p.access_plan, p.access_expires_at, p.credits_balance
  FROM public.profiles p
 WHERE p.subscription_status IN ('paid', 'starter', 'creator', 'professional')
   AND p.access_expires_at IS NULL;

-- 3. Expired accounts that will now see the plan selection instead of the
--    app (their data is kept). Newest first.
SELECT p.id, p.access_plan AS last_plan, p.access_expires_at, p.subscription_status, p.credits_balance
  FROM public.profiles p
 WHERE p.access_expires_at <= now()
 ORDER BY p.access_expires_at DESC
 LIMIT 100;

-- 4. Consistency: the profile's end date vs. the latest paid purchase.
--    access_expires_at should equal the latest access_end of a paid
--    purchase (stacked renewals end later). Rows here deserve a look;
--    legacy subscribers (legacy_entitlements) are kept current separately
--    and may legitimately differ.
SELECT p.id, p.access_expires_at, x.last_end, x.paid_purchases,
       (SELECT status FROM public.legacy_entitlements le WHERE le.user_id = p.id) AS legacy_status
  FROM public.profiles p
  JOIN (SELECT user_id, MAX(access_end) AS last_end, COUNT(*) AS paid_purchases
          FROM public.purchases
         WHERE status IN ('paid', 'partially_refunded')
         GROUP BY user_id) x ON x.user_id = p.id
 WHERE p.access_expires_at IS DISTINCT FROM x.last_end;

-- 5. Legacy subscribers protected by legacy_entitlements: their access is
--    kept ahead by the access job; listed for information.
SELECT le.user_id, le.status, p.subscription_status, p.access_expires_at
  FROM public.legacy_entitlements le
  JOIN public.profiles p ON p.id = le.user_id
 ORDER BY le.status, p.access_expires_at;
