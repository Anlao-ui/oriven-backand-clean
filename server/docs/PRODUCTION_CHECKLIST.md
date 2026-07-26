# Oriven — Production Checklist

Written at the end of V10 (Production Readiness). Honest status, not aspirational — items marked "not verified" genuinely weren't, because this environment has no browser automation and no live ad-account test data (a limitation disclosed at every phase of this project, not new to this checklist).

## Before anything else

- [ ] **Commit and push both repositories.** As of V10, every change from V6 (Marketing Intelligence) through V9 (Autopilot) exists only as uncommitted working-tree changes in **both** `C:\files` and `C:\files\oriven-backand-clean\server` (confirmed via `git status` in both — modified files with no intervening commits, and several backend files, including `services/toolRouter.js` and the entire `tools/` directory, are untracked, not just modified). Nothing in this project has touched git history without being explicitly asked, so this is still true right now. This is the single biggest launch-readiness gap and the first thing to fix.
- [ ] Run the four `CREATE TABLE`/`ALTER TABLE` scripts from V7–V9 in the production Supabase instance if they haven't been run there yet (see `DATABASE.md`).
- [ ] Set every variable in `ENVIRONMENT.md` in the production Render environment.

## Security (Epic 4 — done this pass)

- [x] Ownership checks audited: every `:id`-scoped mutation in `server.js` chains `.eq('user_id', ...)`. No IDOR gaps found.
- [x] `automation_rules`' `trigger_metric`/`trigger_operator`/`action_type`/`platform` are now constrained server-side to the exact values the rule evaluator understands (previously accepted arbitrary strings that would silently never fire).
- [x] `toolRouter.executeDirect` (V9) confirmed reachable only from routes that already re-verify ownership of the calling recommendation/rule before invoking it.
- [ ] Not done this pass: a full input-validation sweep of all ~150 routes (spot-checked the newest/loosest ones only — see Epic 4 in the V10 plan for scope reasoning).

## Reliability (Epic 5 — partially done this pass)

- [x] The generic-generation routes most likely to leak a raw provider/SMTP error message (`generate-image`, `generate-email`, invite email, `generate-logo`, UGC script/video generation) now return a clean, branded message while still logging the real error server-side.
- [ ] Deliberately left as-is: Google/Meta/TikTok campaign-management routes, which forward the platform's own rejection reason (e.g. "invalid budget," "targeting rejected") to the user — a real and useful pattern for this category of product, not a leak, so not "fixed."

## Dead code / cleanup (Epics 1 & 15 — done this pass)

- [x] Removed the unused `posters-image` modelRouter task (posters generate via HTML, never called this task).
- [x] Removed confirmed-orphaned CSS (`.st-canvas`/`.st-content-col`/`.st-intel-col` — verified zero references in any `.js` or `.html` file before removal; the similarly-named `.se-*`/`.snav-item` classes were checked too and found to be **live**, used by `settings.js`'s dynamically-rendered sidebar — not removed).
- [ ] `@anthropic-ai/sdk` and `openai` are listed in `package.json` but never imported anywhere (confirmed by grep) — safe to remove, not done this pass to avoid an untested dependency change this close to launch.
- [ ] `oriven-backand-clean-backup/` is a confirmed-stale mirror directory, never touched across this entire project — flagged, not deleted; that's your call.

## Database (Epic 8 — reviewed, no changes needed)

- [x] Every table from V7–V9 reviewed for redundant columns/missing indexes — came back clean. See `DATABASE.md`.

## Onboarding (Epic 11 — done this pass)

- [x] The existing spotlight tour (`auth.js`, `_OB_STEPS`) now includes the Creative Workspace and Autopilot pages (added in V8/V9, after the tour was originally built).
- [ ] Not covered: Business Brain has no entry in the top nav the tour walks (it's reached through a different internal navigation) — a real gap worth a follow-up, not fixed here to avoid changing primary navigation structure in a hardening pass.

## Settings (Epic 12 — done this pass)

- [x] Added a real "Autopilot Approvals" notification toggle (`settings.js`/`app.html`), wired to actually gate the notification bell's approval fetch — not just a cosmetic toggle.

## Accessibility (Epic 13 — partial, code-level only)

- [x] Added `aria-label`s to the icon-only/unlabeled controls on the two newest pages (Creative Workspace, Autopilot Center): compare-modal close, new-rule-modal close, product/status/rule selects, both search inputs.
- [ ] Not verified: contrast ratios, screen-reader behavior, keyboard-trap testing — this environment has no assistive-tech testing tool.

## Responsive (Epic 10 — verified, no changes needed)

- [x] Confirmed both new pages already collapse to a single column below their breakpoints (`.crws-layout` at 1100px, `.ap-op-grid` at 1000px) — built in during V8/V9, still correct.
- [ ] Not verified: actual rendering on a real tablet/phone — no device/browser testing available here.

## Testing (Epic 9 — route-level only, as in every prior phase)

- [x] Every route touched this pass re-verified via `curl`: correct 401 on missing auth, no regressions in guest chat, the Tool Router, or existing reflection periods.
- [ ] Not done: exhaustive UI click-through testing of every page/modal/action — no browser automation tool in this environment. Every prior phase (V6–V9) disclosed the same limitation; this is not new to V10.

## Documentation (Epic 14 — done this pass)

- [x] `ARCHITECTURE.md`, `DATABASE.md`, `API.md`, `ENVIRONMENT.md`, `DEPLOYMENT.md`, this file.
