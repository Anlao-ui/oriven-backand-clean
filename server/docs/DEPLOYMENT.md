# Oriven — Deployment Guide

Based on how this app actually runs today, not a generic template. Confirmed from `server.js`'s own branching logic (`process.env.RENDER`) and every successful local boot performed during this project.

## Topology

Two separate deployments, matching the two separate git repos:

- **Backend** — this repo, deployed to Render as a standard Node web service (`npm start` → `node server.js`). Render sets `RENDER=true` and `RENDER_EXTERNAL_URL` automatically; the app uses these to decide whether to redirect unknown paths to the frontend (`RENDER` set) or serve a local file (`RENDER` unset, local dev).
- **Frontend** — `C:\files`, served as static files. The backend's fallback route (`app.use(...)` at the very end of `server.js`, after every real route) redirects unknown paths to `FRONTEND_URL + '/app'` in production, or serves the file from disk directly in local dev.

## Environment variables

See `ENVIRONMENT.md` — every variable there must be set in Render's environment settings for the backend service before deploy. Missing SMTP variables degrade gracefully (email skipped with a warning); every other missing variable will either crash on boot or fail the first request that needs it (Stripe, ad platform OAuth, AIML).

## Database

Supabase, service-role access only. **There is no migrations tool in this codebase.** Before deploying any change that depends on a new table or column (see `DATABASE.md` for the full list added across V7–V9), that SQL must be run manually in the Supabase SQL editor first — deploying the code without doing this will make the new routes 500 on their first real query, not fail at boot (`supabaseAdmin` doesn't validate schema at startup).

## Background jobs

`node-cron` schedules run in-process, inside the same web service — there is no separate worker/queue. This means:
- The 4-hourly monitoring cron (`_runIntelligenceMonitoring`), the 3 daily-brief crons (8am/1pm/6pm UTC), and the nightly cleanup cron all depend on the web service staying up continuously. A restart mid-cycle simply skips that cycle's run (`node-cron` doesn't persist missed schedules) — acceptable for this app's cadence, worth knowing if Render's plan allows the instance to sleep.

## Local development

```bash
cd oriven-backand-clean/server
npm install
npm start
```

Requires a `.env` file **one directory above the frontend root** (`C:\files\.env` in this project's layout, loaded via `dotenv` — confirmed working, not a misconfiguration) containing every variable in `ENVIRONMENT.md`. Confirm the boot log shows every `✅ [ENV]` line before testing — a missing variable logs a warning but the server still starts, which can mask a real misconfiguration until the first request that needs it fails.

## Pre-deploy checklist

See `PRODUCTION_CHECKLIST.md`.
