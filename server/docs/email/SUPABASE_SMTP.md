# Supabase Auth emails through Resend (password reset from contact@orivenai.com)

Supabase Auth keeps doing everything security-related — the recovery token,
its expiry, single use, rate limits and the password update. Only the
delivery changes: Supabase hands its emails to Resend over SMTP, and the
reset email uses OrivenAI's template.

None of this is code; it is configured in two dashboards. Nothing here is
set automatically.

## 1. Resend — sending domain and an SMTP key

1. resend.com → **Domains**: `orivenai.com` must show **Verified**
   (public DNS already has its Resend DKIM record, `resend._domainkey.orivenai.com`,
   and the `send.orivenai.com` return path; confirm the status in Resend).
   `contact@orivenai.com` can only be used as sender on a verified `orivenai.com`.
2. resend.com → **API Keys** → **Create API key**: name `supabase-auth-smtp`,
   permission **Sending access**, domain **orivenai.com**. Copy it once; it is
   the SMTP password below. Don't reuse the backend's `RESEND_API_KEY`.

## 2. Supabase — custom SMTP

Supabase dashboard → project → **Authentication** → **Emails** → **SMTP Settings**
(older dashboards: Project Settings → Authentication → SMTP) → **Enable custom SMTP**:

| Field | Value |
|---|---|
| Sender email | `contact@orivenai.com` |
| Sender name | `OrivenAI` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | the key from step 1.2 |
| Minimum interval between emails | keep the default |

Save. Supabase now sends **all** its auth emails through Resend (password
reset, email change, invite, magic link — OrivenAI's own verification email is
sent by the backend, not by Supabase, and is unaffected).

**Authentication → Rate Limits**: with custom SMTP, "Rate limit for sending
emails" becomes editable (Supabase's default is low). Keep it modest, e.g.
30–60 per hour; the per-address limit on recovery requests stays in place.

## 3. Supabase — the reset email template

**Authentication** → **Emails** → **Templates** → **Reset password**:

- Subject: `Reset your OrivenAI password`
- Body (HTML): the full contents of `docs/email/supabase-reset-password.html`
  (generated from `services/email/templates.js` by
  `node scripts/supabase-email-templates.js`). It uses Supabase's own
  `{{ .ConfirmationURL }}` — leave it exactly as is.

## 4. Supabase — where the link may return to

**Authentication** → **URL Configuration**:

- Site URL: `https://orivenai.com`
- Redirect URLs must include `https://orivenai.com/app` (the app sends
  `redirectTo: <origin>/app`; a link to an unlisted URL falls back to the Site
  URL, which the app also handles).

## 5. Verify (one real reset, on your own account)

1. orivenai.com/login → your email → **Forgot password?** The page says
   "If an OrivenAI account exists for this email, a reset link is on its way."
2. The email arrives from **OrivenAI <contact@orivenai.com>**, subject
   "Reset your OrivenAI password", with the OrivenAI layout.
   In Resend → **Emails** it appears as sent; in Supabase → Logs → Auth the
   recovery request shows no SMTP error.
3. Click **Reset Password** → the app shows "set a new password" → save.
4. Sign out, sign in with the new password (works) and the old one (fails).
5. Click the same email link again → the app says the link has expired or
   was already used.
6. Create a new account to confirm signup verification still arrives
   (backend email, unaffected by these settings).

If step 2 fails (no email), Supabase → Logs → Auth shows the SMTP error;
switching custom SMTP off restores Supabase's default sender immediately.
