// Password reset email (Supabase Auth → custom SMTP through Resend).
//   node tests/password-reset-email.test.js
// Supabase sends this email; the HTML comes from services/email/templates.js
// (supabaseAuthTemplate) and is kept in docs/email/ for the dashboard. No
// network, no credentials, nothing is sent.
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const T = require('../services/email/templates');

let pass = 0, fail = 0;
const check = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS ' : '  FAIL ') + n + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 300))); };
const ROOT = path.join(__dirname, '..');
const t = T.supabaseAuthTemplate('reset_password');
const html = t.html;
const text = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&rarr;/g, '→').replace(/\s+/g, ' ');

console.log('\nA. Content');
check('subject: "Reset your OrivenAI password"', t.subject === 'Reset your OrivenAI password');
check('headline "Reset your password"', /<h1[^>]*>Reset your password<\/h1>/.test(html));
check('description', text.includes('We received a request to reset the password for your OrivenAI account.'));
check('primary button "Reset Password"', /class="btn"[\s\S]*?>Reset Password&nbsp;&rarr;<\/a>/.test(html));
check('footer: "If you did not request this change, you can safely ignore this email."', text.includes('If you did not request this change, you can safely ignore this email.'));
check('OrivenAI branding: logo, name, lime button, dark header', html.includes('https://orivenai.com/assets/orivenlogo.png') && />OrivenAI</.test(html) && /bgcolor="#B7FF2A"/.test(html) && /bgcolor="#0A0A0A"/.test(html));
check('contact address in the footer', html.includes('mailto:contact@orivenai.com'));
check('mobile layout + hidden preheader', /max-width:620px/.test(html) && /display:none;max-height:0/.test(html));
check('no marketing: no unsubscribe link, no prices or plans', !/unsubscribe/i.test(html) && !/€|Starter|Creator|Professional/.test(text));

console.log('\nB. The link is Supabase’s own one-time recovery link');
const hrefs = (html.match(/href="([^"]+)"/g) || []).map((h) => h.slice(6, -1));
check('button and fallback link both use {{ .ConfirmationURL }}', hrefs.filter((h) => h === '{{ .ConfirmationURL }}').length === 2, hrefs);
check('every other link is https or mailto (no custom reset URL, no token in the template)', hrefs.filter((h) => h !== '{{ .ConfirmationURL }}').every((h) => /^(https:\/\/|mailto:)/.test(h)) && !/token=|\{\{ \.Token/.test(html), hrefs);
check('no secrets or SMTP settings in the template', !/re_[A-Za-z0-9]{10,}|service_role|smtp\.|password=/i.test(html));
check('the email doesn’t state a fixed expiry (Supabase’s own setting decides it)', !/\b\d+\s*(minutes|hours|hour|days)\b/i.test(text));

console.log('\nC. Dashboard copy is up to date');
let fresh = true;
try { execFileSync(process.execPath, [path.join(ROOT, 'scripts/supabase-email-templates.js'), '--check'], { stdio: 'pipe' }); } catch (_) { fresh = false; }
check('docs/email/supabase-reset-password.html matches the source (scripts/supabase-email-templates.js --check)', fresh);
const doc = fs.readFileSync(path.join(ROOT, 'docs/email/supabase-reset-password.html'), 'utf8');
check('docs file names where it goes and its subject', /Supabase → Authentication → Emails → "Reset password"\. Subject: Reset your OrivenAI password/.test(doc));
check('lifecycle templates untouched (Supabase template is not in TEMPLATES)', !Object.keys(T.TEMPLATES).some((k) => /reset|password/i.test(k)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
