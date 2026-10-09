# Oriven — Environment Variables

Extracted directly from `process.env.*` references across `server.js`, `providers/`, and `services/` (grepped, not guessed) at V10. Every variable below is one this session's server boots actually depended on.

## Core / infrastructure

| Variable | Purpose |
|---|---|
| `PORT` | Port the Express server listens on (defaults to `5500` in local dev). |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key — bypasses RLS. Every query in this codebase relies on **application-level** `user_id` filtering, not RLS, because of this. |
| `RENDER` | Set automatically by Render in production; used to branch behavior (e.g. serving `/app` vs a local file fallback). |
| `RENDER_EXTERNAL_URL` | The deployed backend's own public URL. |
| `FRONTEND_URL` | The deployed frontend's public URL, used in redirects and emails. |

## AI

| Variable | Purpose |
|---|---|
| `AIML_API_KEY` | The single AI provider key — every text/image/video generation in this app goes through the AIML gateway (see `ARCHITECTURE.md`). |

## Ad platforms

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google OAuth. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Required for all Google Ads API calls, separate from OAuth. |
| `META_APP_ID` / `META_APP_SECRET` / `META_REDIRECT_URI` | Meta OAuth. |
| `TIKTOK_APP_ID` / `TIKTOK_APP_SECRET` / `TIKTOK_REDIRECT_URI` | TikTok OAuth. |

## Billing

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe API key. |
| `STRIPE_WEBHOOK_SECRET` | Verifies `/api/stripe-webhook` signatures. |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_CREATOR` / `STRIPE_PRICE_PROFESSIONAL` | Price IDs for the three paid plans. |

## Free first ad (onboarding)

| Variable | Purpose |
|---|---|
| `FREE_FIRST_AD_ENABLED` | `true` turns on the one free ad image for new Free accounts (`services/firstAd.js`) and the "Create Your First Ad" onboarding flow. Off by default. |
| `FREE_FIRST_AD_SINCE` | Launch cutoff, ISO time (e.g. `2026-10-12T09:00:00Z`). Only accounts created on or after it qualify. Required: unset or invalid = nobody qualifies, even with the flag on. Set it to the moment you enable the feature; never move it earlier. |

## Email

| Variable | Purpose |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Fallback for the verification email (and support replies). Used when Resend can't deliver to the address or fails. If unset, verification emails are skipped with a startup warning. |
| `EMAIL_MODE` | `off` (default) — Resend sends nothing · `test` — only addresses in `EMAIL_TEST_ALLOWLIST` receive email (subject `[TEST]`), with separate records/idempotency keys · `live` — real delivery. |
| `EMAIL_TEST_ALLOWLIST` | Comma-separated test addresses (your own). In `test` mode nothing else is processed or sent. |
| `RESEND_API_KEY` | Resend sending key (secret). |
| `EMAIL_FROM` | Sender on the verified Resend domain, e.g. `OrivenAI <hello@mail.orivenai.com>`. |
| `EMAIL_REPLY_TO` | Optional reply-to address. |
| `EMAIL_UNSUBSCRIBE_SECRET` | Long random string; signs unsubscribe links. Without it, marketing emails are skipped. |
| `RESEND_WEBHOOK_SECRET` | `whsec_…` signing secret of the Resend webhook (`/api/email/webhook`). Without it, every webhook call is rejected. |
| `EMAIL_POSTAL_ADDRESS` | Company address shown in the email footer. |
| `EMAIL_LIFECYCLE_ENABLED` | `true` registers the 15-minute lifecycle job (welcome, reminders, …). Off by default. |
| `EMAIL_LIFECYCLE_SINCE` | Optional; only accounts created on/after this date get lifecycle email (default: onboarding rollout). |
| `PUBLIC_API_URL` | Optional; base for unsubscribe links (default: the Render URL). |

## Not required to boot, but referenced

None found — every variable above was observed in a real, successful local boot against the project's own `.env` (loaded via `dotenv` from the frontend repo root, `C:\files\.env`, one directory up from this server — an unusual but confirmed-working layout, not a typo).
