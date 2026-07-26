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

## Email

| Variable | Purpose |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Transactional email (verification, invites). If unset, verification emails are skipped with a startup warning rather than a hard failure — confirmed in the boot log every phase of this project. |

## Not required to boot, but referenced

None found — every variable above was observed in a real, successful local boot against the project's own `.env` (loaded via `dotenv` from the frontend repo root, `C:\files\.env`, one directory up from this server — an unusual but confirmed-working layout, not a typo).
