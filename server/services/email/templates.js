// ── Lifecycle email templates ────────────────────────────────────────
//
// Six lifecycle emails + the verification email (see
// services/email/lifecycle.js for when each is sent). Every template
// returns { subject, html, text, category }:
//   category 'service'   — account / purchase information; sent without
//                          marketing consent, never contains promotion;
//   category 'marketing' — lifecycle encouragement; only with marketing
//                          consent, always with an unsubscribe link.
//
// Brand: the app's dark surface (#0A0A0A) for the header band, OrivenAI lime
// (#B7FF2A) for the one primary action and small accents, warm off-white page
// (#F6F3EE), charcoal text (#18181A), muted (#6B6B6B); Instrument Serif for
// headings and Geist for text where the mail client loads web fonts, with
// Georgia / system sans as the fallbacks. Table layout and inline styles so it
// renders in Outlook and Gmail; 600px column that becomes full-width on phones
// (the <style> block only adds mobile refinements — nothing depends on it).
//
// Copy rules: short and concrete; one primary action per email; plan facts
// come from PLAN_INTRO below (keep in line with services/planEntitlements.js,
// services/creditManager.js PLAN_ALLOWANCES and the Stripe prices); no
// urgency, no claims the product can't back.

const C = {
  page: '#F6F3EE', card: '#FFFFFF', ink: '#18181A', body: '#2C2C2E', muted: '#6B6B6B', line: '#E7E1D8',
  panel: '#F6F3EE', dark: '#0A0A0A', darkInk: '#F4F4F2', darkMuted: '#9A9A96', lime: '#B7FF2A', limeInk: '#0A0A0A',
};
const LOGO = 'https://orivenai.com/assets/orivenlogo.png';
const SANS = "Geist,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "'Instrument Serif',Georgia,'Times New Roman',serif";

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = (n) => Number(n).toLocaleString('en-US'); // 1000 → "1,000"

// ── Plan facts (single source for every email) ──────────────────────
const PLAN_INTRO = {
  starter: { name: 'Starter', price: '9.95', credits: 1000,
    unlocks: ['Research: investigate your market, competitors and audience', 'Automations: schedule campaigns and set rules that pause, resume or adjust them, or ask you first'] },
  creator: { name: 'Creator', price: '19.95', credits: 2500,
    unlocks: ['Everything in Starter: Research and Automations', 'Oriven Chat, your advertising assistant inside the app', 'In-app notifications'] },
  professional: { name: 'Professional', price: '34.95', credits: 4000,
    unlocks: ['Everything in Creator: Research, Automations, Oriven Chat and in-app notifications', 'Priority Support', 'Weekly AI Performance Report by email'] },
};
const FREE = { name: 'Free', creditsPerDay: 10 };
const planOf = (k) => PLAN_INTRO[k] || null;
const creditLine = (plan) => `${fmt(plan.credits)} credits a month for Create, Research and more`;
const planList = (plan) => [creditLine(plan)].concat(plan.unlocks);

// ── Building blocks ─────────────────────────────────────────────────
const p = (t, extra) => `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${C.body}${extra ? ';' + extra : ''}">${t}</p>`;
const small = (t) => `<p style="margin:0 0 10px;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.muted}">${t}</p>`;
const link = (label, url) => `<a href="${esc(url)}" style="color:${C.ink};font-weight:600;text-decoration:underline">${label}</a>`;

function button(label, url) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" class="btn" style="margin:28px 0 8px"><tr>` +
    `<td align="center" bgcolor="${C.lime}" style="border-radius:12px;background:${C.lime};mso-padding-alt:15px 28px">` +
    `<a href="${esc(url)}" style="display:inline-block;padding:15px 28px;font-family:${SANS};font-size:16px;font-weight:600;line-height:1.2;color:${C.limeInk};text-decoration:none;border-radius:12px">${esc(label)}&nbsp;&rarr;</a>` +
    `</td></tr></table>`;
}

// Numbered steps — only for content that really is a sequence.
function steps(items) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:6px 0 4px">` +
    items.map((it, i) => `<tr>` +
      `<td valign="top" width="40" style="padding:0 14px 18px 0"><div style="width:28px;height:28px;line-height:28px;border-radius:14px;background:${C.dark};color:${C.lime};font-family:${SANS};font-size:13px;font-weight:700;text-align:center">${i + 1}</div></td>` +
      `<td valign="top" style="padding:3px 0 18px;font-family:${SANS};font-size:15px;line-height:1.55;color:${C.body}"><strong style="color:${C.ink};font-weight:600">${it[0]}</strong><br>${it[1]}</td>` +
      `</tr>`).join('') +
    `</table>`;
}

// Checklist for what a plan includes (unordered facts).
function checks(items) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">` +
    items.map((t) => `<tr>` +
      `<td valign="top" width="30" style="padding:1px 10px 10px 0"><div style="width:20px;height:20px;line-height:20px;border-radius:10px;background:${C.dark};color:${C.lime};font-family:${SANS};font-size:12px;font-weight:700;text-align:center">&#10003;</div></td>` +
      `<td valign="top" style="padding:0 0 10px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.body}">${t}</td>` +
      `</tr>`).join('') +
    `</table>`;
}

// Soft panel with a small label, e.g. "Your plan".
function panel(label, inner) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 20px"><tr>` +
    `<td bgcolor="${C.panel}" style="background:${C.panel};border:1px solid ${C.line};border-radius:14px;padding:20px 22px 12px">` +
    `<p style="margin:0 0 14px;font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:${C.muted}">${label}</p>` +
    inner + `</td></tr></table>`;
}

// Two plan columns side by side; stacked on phones.
function compare(left, right) {
  const col = (c, hi) => `<td class="col" valign="top" width="50%" style="padding:0 ${hi ? '0' : '6px'} 0 ${hi ? '6px' : '0'}">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="${hi ? C.dark : C.panel}" style="background:${hi ? C.dark : C.panel};border:1px solid ${hi ? C.dark : C.line};border-radius:14px;padding:18px 18px 8px">` +
    `<p style="margin:0 0 2px;font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:${hi ? C.lime : C.muted}">${c.name}</p>` +
    `<p style="margin:0 0 14px;font-family:${SERIF};font-size:26px;line-height:1.2;color:${hi ? C.darkInk : C.ink}">${c.price}</p>` +
    c.items.map((t) => `<p style="margin:0 0 10px;font-family:${SANS};font-size:14px;line-height:1.45;color:${hi ? C.darkInk : C.body}">${t}</p>`).join('') +
    `</td></tr></table></td>`;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 20px"><tr>${col(left, false)}${col(right, true)}</tr></table>`;
}

// ctx: { appUrl, unsubscribeUrl?, postalAddress? } — postalAddress is the full
// sender line (EMAIL_POSTAL_ADDRESS, e.g. "OrivenAI B.V. · Street 1, 1234 AB City · KvK …"). — postalAddress is the full sender line
// (EMAIL_POSTAL_ADDRESS, e.g. "OrivenAI B.V. · Street 1, 1234 AB City · KvK …").
function layout({ eyebrow, heading, preheader, body, ctx, category, why, lang }) {
  const footer =
    small(esc(why)) +
    (category === 'marketing' && ctx.unsubscribeUrl
      ? small(`Don’t want these emails? <a href="${esc(ctx.unsubscribeUrl)}" style="color:${C.muted};text-decoration:underline">Unsubscribe</a>. Account and billing emails will still reach you.`)
      : '') +
    small(`${ctx.postalAddress ? esc(ctx.postalAddress) : 'OrivenAI'} · <a href="mailto:contact@orivenai.com" style="color:${C.muted};text-decoration:underline">contact@orivenai.com</a>`);
  return `<!doctype html><html lang="${esc(lang || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(heading)}</title>` +
    `<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Geist:wght@400;600;700&display=swap" rel="stylesheet">` +
    `<style>` +
    `a{color:inherit}` +
    `@media only screen and (max-width:620px){` +
    `.wrap{padding:16px 10px 28px!important}.hd{padding:24px 22px 26px!important}.bd{padding:28px 22px 12px!important}` +
    `.h1{font-size:30px!important}.btn{width:100%!important}.btn td{display:block!important}.btn a{display:block!important;text-align:center!important}` +
    `.col{display:block!important;width:100%!important;padding:0 0 12px!important}.ft{padding:20px 12px 0!important}}` +
    `</style></head>` +
    `<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">` +
    (preheader ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>` : '') +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${C.page}" style="background:${C.page}"><tr><td align="center" class="wrap" style="padding:32px 16px 40px">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">` +
    // Header band — the app's dark surface, logo, eyebrow and heading.
    `<tr><td class="hd" bgcolor="${C.dark}" style="background:${C.dark};border-radius:18px 18px 0 0;padding:28px 36px 32px">` +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>` +
    `<td valign="middle"><img src="${LOGO}" width="30" height="30" alt="" style="display:block;border:0;border-radius:8px"></td>` +
    `<td valign="middle" style="padding-left:10px;font-family:${SANS};font-size:16px;font-weight:700;letter-spacing:.2px;color:${C.darkInk}">OrivenAI</td>` +
    `</tr></table>` +
    (eyebrow ? `<p style="margin:30px 0 8px;font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:${C.lime}">${esc(eyebrow)}</p>` : '<div style="height:26px"></div>') +
    `<h1 class="h1" style="margin:0;font-family:${SERIF};font-weight:400;font-size:36px;line-height:1.15;color:${C.darkInk}">${esc(heading)}</h1>` +
    `</td></tr>` +
    // Body card
    `<tr><td class="bd" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-top:0;border-radius:0 0 18px 18px;padding:32px 36px 16px">${body}</td></tr>` +
    `<tr><td class="ft" style="padding:24px 8px 0">${footer}</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

// Plain-text footer, matching the HTML one.
function textFooter(ctx, category, why) {
  return `\n\n—\n${why}` +
    (category === 'marketing' && ctx.unsubscribeUrl ? `\nUnsubscribe: ${ctx.unsubscribeUrl}` : '') +
    `\n${ctx.postalAddress || 'OrivenAI'} · contact@orivenai.com`;
}

function make({ category, subject, eyebrow, heading, preheader, body, text, ctx, why, lang }) {
  return { category, subject, html: layout({ eyebrow, heading, preheader, body, ctx, category, why, lang }), text: text + textFooter(ctx, category, why) };
}

const WHY = {
  signup: 'You’re receiving this because this address was used to create an OrivenAI account.',
  account: 'You’re receiving this because you created an OrivenAI account.',
  product: 'You’re receiving this because you agreed to product emails from OrivenAI.',
};

const TEMPLATES = {
  // Automations — one grouped account-activity email per run (service: it
  // reports changes made to the user's own ad accounts). Sent only when the
  // user has automation emails on (Automations → Settings); the footer links
  // there and to a one-click "turn off automation emails".
  automation_update(d, ctx) {
    const items = (d.items || []).slice(0, 10);
    const more = Math.max(0, (d.count || items.length) - items.length);
    const list = items.map((i) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.line};font-family:${SANS};font-size:15px;line-height:1.5;color:${C.body}"><strong style="color:${C.ink}">${esc(i.title)}</strong>${i.detail ? `<br><span style="color:${C.muted};font-size:14px">${esc(i.detail)}</span>` : ''}</td></tr>`).join('');
    const body =
      p(d.count === 1 ? 'An automation in your OrivenAI account needs your attention or has just acted:' : `${d.count} updates from the automations in your OrivenAI account:`) +
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 8px">${list}</table>` +
      (more ? small(`And ${more} more in Automations → Activity.`) : '') +
      button('Open Automations', d.appUrl || ctx.appUrl) +
      small(`You get these emails because automation emails are on. ${d.settingsUrl ? link('Change what you receive', d.settingsUrl) : ''}${d.offUrl ? ' · ' + link('Turn off automation emails', d.offUrl) : ''}`);
    const subject = d.subject || (d.count === 1 ? (items[0] && items[0].title) || 'Automation update' : `${d.count} automation updates`);
    return make({ category: 'service', subject: String(subject).slice(0, 120), eyebrow: 'Automations', heading: d.count === 1 ? 'Automation update' : 'Automation updates',
      preheader: items.map((i) => i.title).join(' · ').slice(0, 140) || 'Updates from the automations in your OrivenAI account.', body, ctx, why: 'You’re receiving this because automations in your OrivenAI account have automation emails turned on.',
      text: (d.count === 1 ? 'An automation in your OrivenAI account:\n' : `${d.count} automation updates:\n`) + items.map((i) => `- ${i.title}${i.detail ? ': ' + i.detail : ''}`).join('\n') + (more ? `\n…and ${more} more in Automations → Activity.` : '') +
        `\n\nOpen Automations: ${d.appUrl || ctx.appUrl}` + (d.offUrl ? `\nTurn off automation emails: ${d.offUrl}` : '') });
  },

  // Email address verification (transactional — sent right after signup and
  // on "resend", regardless of marketing consent). services/email/verification.js
  verify_email(d, ctx) {
    const days = d.validDays || 14;
    const hi = d.firstName ? `Hi ${esc(d.firstName)},` : 'Hi,';
    const body =
      p(`${hi} one quick step before you start: confirm that this is your email address, so we can reach you about your account.`) +
      button('Confirm my email', d.verifyUrl) +
      small(`The link works for ${days} days and can be used once. If the button doesn’t work, paste this address into your browser:<br><a href="${esc(d.verifyUrl)}" style="color:${C.muted};word-break:break-all">${esc(d.verifyUrl)}</a>`) +
      small(`Didn’t create an OrivenAI account? You can ignore this email; nothing will happen.`);
    return make({ category: 'service', subject: 'Confirm your email for OrivenAI', eyebrow: 'Your account', heading: 'Confirm your email',
      preheader: 'One click to confirm your address and finish setting up OrivenAI.', body, ctx, why: WHY.signup,
      text: `${d.firstName ? 'Hi ' + d.firstName + ',' : 'Hi,'}\n\nPlease confirm that this is your email address for OrivenAI:\n${d.verifyUrl}\n\nThe link works for ${days} days and can be used once. Didn’t create an OrivenAI account? You can ignore this email.` });
  },

  // 1 — Welcome (service). Carries the verification link when one is pending,
  // so a new user gets one email, not two. Informational: how to start, no
  // promotion of paid plans.
  welcome(d, ctx) {
    const create = ctx.appUrl + '?start=create';
    const body =
      p(`Your OrivenAI workspace is ready. It brings your advertising for Google, Meta, TikTok and Pinterest into one place: research your market, create the ads, launch them and follow how they perform.`) +
      (d.verifyUrl ? p(`First, confirm this is your email address:`) + button('Confirm my email', d.verifyUrl) + small(`The link works for 14 days.`) + `<div style="height:16px"></div>` : '') +
      p(`<strong style="color:${C.ink}">Getting your first ad live</strong>`, 'margin-bottom:12px') +
      steps([
        ['Create', 'Describe what you sell and who it’s for, then pick a platform. OrivenAI writes the headlines, ad copy and targeting, and suggests visual concepts.'],
        ['Review in Launch', 'Your draft goes to Launch, where you see what’s ready to publish and what still needs attention.'],
        ['Publish and follow', 'Connect your ad account, publish when you choose, and follow results in Campaigns.'],
      ]) +
      // One primary action per email: when confirming is the ask, the app link is secondary.
      (d.verifyUrl ? p(link('Create my first ad &rarr;', create)) : button('Create my first ad', create)) +
      small(`Questions? Write to <a href="mailto:contact@orivenai.com" style="color:${C.muted};text-decoration:underline">contact@orivenai.com</a>.`);
    return make({ category: 'service', subject: 'Welcome to OrivenAI', eyebrow: 'Welcome', heading: d.firstName ? `Welcome, ${d.firstName}` : 'Welcome to OrivenAI',
      preheader: 'Your workspace is ready. Here’s how to get your first ad live.', body, ctx, why: WHY.account,
      text: `Welcome${d.firstName ? ', ' + d.firstName : ' to OrivenAI'}\n\nYour OrivenAI workspace is ready: research your market, create ads for Google, Meta, TikTok and Pinterest, launch them and follow how they perform.\n\n` +
        (d.verifyUrl ? `First, confirm your email (link works 14 days):\n${d.verifyUrl}\n\n` : '') +
        `Getting your first ad live:\n1. Create: describe what you sell and who it’s for, then pick a platform.\n2. Review in Launch: see what’s ready to publish.\n3. Publish and follow: connect your ad account, publish when you choose, follow results in Campaigns.\n\nCreate my first ad: ${create}\n\nQuestions? contact@orivenai.com` });
  },

  // 2 — First-ad reminder (marketing). The plan line depends on the account:
  // the free first ad only when the server says the account still has it,
  // the daily Free build only on Free, the monthly credits on a paid plan.
  first_ad_reminder(d, ctx) {
    const create = ctx.appUrl + '?start=create';
    const paid = planOf(d.plan);
    const planLine = d.freeFirstAd && !paid
      ? 'Your first complete ad, including its image, is on us.'
      : paid
        ? `Your ${paid.name} plan includes ${creditLine(paid)}.`
        : 'On the Free plan you can build one campaign every 24 hours.';
    const body =
      p(`You haven’t created your first ad yet. It takes a few minutes, and you stay in control of what gets published.`) +
      steps([
        ['Describe your offer', 'What you sell, who it’s for and what makes it different.'],
        ['Pick a platform', 'Google, Meta, TikTok or Pinterest.'],
        ['Get a complete draft', 'Headlines, ad copy, targeting and visual concepts, ready to review in Launch.'],
      ]) +
      panel(paid ? 'Your plan' : 'Good to know', p(esc(planLine), 'margin-bottom:8px;font-size:15px')) +
      button('Create my first ad', create);
    return make({ category: 'marketing', subject: d.freeFirstAd && !paid ? 'Your first ad is ready to make, and it’s free' : 'Your first ad is a few minutes away',
      eyebrow: 'Your first ad', heading: 'Ready for your first ad?', preheader: 'Describe your offer, pick a platform, and review a complete draft.', body, ctx, why: WHY.product,
      text: `Ready for your first ad?\n\nIt takes a few minutes:\n1. Describe your offer: what you sell and who it’s for.\n2. Pick a platform: Google, Meta, TikTok or Pinterest.\n3. Get a complete draft (headlines, ad copy, targeting, visual concepts) to review in Launch.\n\n${planLine}\n\nCreate my first ad: ${create}` });
  },

  // 3 — First success (marketing). One next step, depending on what they did.
  first_success(d, ctx) {
    const research = d.kind === 'research';
    if (research) {
      const create = ctx.appUrl + '?start=create';
      const body =
        p(`Your first Research is done. The most useful next step is to turn it into an ad.`) +
        steps([
          ['Open your Market Map', 'Pick the findings that matter: an audience, a gap competitors leave open, a message that works.'],
          ['Use in Create', 'Send them to Create as the brief, so the copy speaks to what you found.'],
          ['Review and launch', 'Check the draft in Launch and publish when you’re ready.'],
        ]) +
        button('Turn it into an ad', create);
      return make({ category: 'marketing', subject: 'Your research is ready. Now put it to work', eyebrow: 'Next step', heading: 'Turn your research into an ad',
        preheader: 'Use your findings as the brief for your next ad.', body, ctx, why: WHY.product,
        text: `Your first Research is done. Next step: turn it into an ad.\n\n1. Open your Market Map and pick the findings that matter.\n2. Use in Create: send them to Create as the brief.\n3. Review the draft in Launch and publish when you’re ready.\n\nTurn it into an ad: ${create}` });
    }
    const researchUrl = ctx.appUrl + '?start=research';
    const body =
      p(`Your first ad is built. From here you can review it in Launch and publish when you’re ready.`) +
      p(`A good way to make the next one stronger is Research: see who you’re really competing with, what they promise and where there’s room for you.`) +
      (d.researchIncluded ? '' : panel('Good to know', p('Research is included from the Starter plan.', 'margin-bottom:8px;font-size:15px'))) +
      button('Explore Research', researchUrl) +
      p(link('Or review your ad in OrivenAI &rarr;', ctx.appUrl), 'margin-top:8px;font-size:15px');
    return make({ category: 'marketing', subject: 'Your first ad is ready. Here’s a good next step', eyebrow: 'Next step', heading: 'Your first ad is ready',
      preheader: 'Review it in Launch, then sharpen the next one with Research.', body, ctx, why: WHY.product,
      text: `Your first ad is built. Review it in Launch and publish when you’re ready.\n\nTo make the next one stronger, use Research: see who you’re competing with and where there’s room for you.${d.researchIncluded ? '' : ' Research is included from the Starter plan.'}\n\nExplore Research: ${researchUrl}\nOpen OrivenAI: ${ctx.appUrl}` });
  },

  // 4 — Inactive (marketing).
  inactive(d, ctx) {
    const body =
      p(`It’s been a few weeks since you last used OrivenAI. Your account is still here whenever you need it.`) +
      panel('What you can do in OrivenAI', checks([
        'Research your market and competitors before you spend on ads',
        'Create ad copy, targeting and visual concepts for Google, Meta, TikTok and Pinterest',
        'Launch your campaigns and follow their results in one place',
      ])) +
      button('Open OrivenAI', ctx.appUrl);
    return make({ category: 'marketing', subject: 'Your OrivenAI workspace is still here', eyebrow: 'Still here', heading: 'Your workspace is waiting',
      preheader: 'Research, create and launch your ads from one place, whenever you’re ready.', body, ctx, why: WHY.product,
      text: `Your OrivenAI workspace is still here.\n\n- Research your market and competitors before you spend on ads\n- Create ad copy, targeting and visual concepts for Google, Meta, TikTok and Pinterest\n- Launch your campaigns and follow their results in one place\n\nOpen OrivenAI: ${ctx.appUrl}` });
  },

  // 5 — Upgrade education (marketing). Explains, factually, what the plan
  // that covers their repeated blocked action includes, next to what Free has.
  upgrade_education(d, ctx) {
    const plan = planOf(d.plan) || PLAN_INTRO.starter;
    const plans = ctx.appUrl + '?plans=1';
    const what = d.action === 'research' ? 'Research' : d.action === 'image' ? 'ad images' : 'more campaign builds';
    const body =
      p(`You’ve tried to use ${esc(what)} a few times on the Free plan. Here’s how Free and ${plan.name} compare, so you can decide what fits.`) +
      compare(
        { name: FREE.name, price: '€0', items: [`${FREE.creditsPerDay} credits a day`, 'One campaign build every 24 hours', 'Create, Launch and Campaigns'] },
        { name: plan.name, price: `€${plan.price}<span style="font-family:${SANS};font-size:14px;color:${C.darkMuted}"> /month</span>`, items: planList(plan).map(esc) },
      ) +
      p(`You can cancel anytime in Settings → Subscription. If Free works for you, there’s nothing you need to do.`, 'font-size:15px') +
      button('Compare plans', plans);
    return make({ category: 'marketing', subject: `What ${plan.name} adds to OrivenAI`, eyebrow: 'Plans', heading: `What ${plan.name} adds`,
      preheader: `${plan.name} is €${plan.price}/month: ${fmt(plan.credits)} credits, Research and Automations.`, body, ctx, why: WHY.product,
      text: `What ${plan.name} adds\n\nYou’ve tried to use ${what} a few times on the Free plan.\n\nFree (€0): ${FREE.creditsPerDay} credits a day, one campaign build every 24 hours.\n${plan.name} (€${plan.price}/month):\n- ${planList(plan).join('\n- ')}\n\nCancel anytime in Settings → Subscription. If Free works for you, there’s nothing you need to do.\n\nCompare plans: ${plans}` });
  },

  // 6 — Paid customer onboarding (service). Only what the plan really has.
  paid_onboarding(d, ctx) {
    const plan = planOf(d.plan) || PLAN_INTRO.starter;
    const chat = d.plan === 'creator' || d.plan === 'professional';
    const body =
      p(`Thanks for choosing ${plan.name}. Your plan is active, and everything below is ready to use now.`) +
      panel(`Your ${plan.name} plan`, checks(planList(plan).map(esc))) +
      p(`<strong style="color:${C.ink}">A good way to start</strong>`, 'margin-bottom:12px') +
      steps([
        ['Run a Research', 'Investigate your market, competitors and audience. The results become a Market Map with sources.'],
        ['Turn it into an ad', 'Use your findings in Create as the brief, then review the draft in Launch.'],
        ['Let Automations help', 'Once a campaign is live, schedule when it runs, or add rules that pause, resume or adjust its budget within limits you set, or ask you first.'],
      ]) +
      (chat ? p(`Stuck at any point? Ask Oriven Chat inside the app; it knows which page you’re on.`, 'font-size:15px') : '') +
      button('Open OrivenAI', ctx.appUrl) +
      small(`Manage or cancel your subscription anytime in Settings → Subscription.`);
    return make({ category: 'service', subject: `Your ${plan.name} plan is active`, eyebrow: 'Plan active', heading: `Welcome to ${plan.name}`,
      preheader: `${fmt(plan.credits)} credits a month, plus Research and Automations. Here’s a good way to start.`, body, ctx, why: `You’re receiving this because you subscribed to OrivenAI ${plan.name}.`,
      text: `Welcome to ${plan.name}. Your plan is active.\n\nYour plan includes:\n- ${planList(plan).join('\n- ')}\n\nA good way to start:\n1. Run a Research on your market, competitors and audience.\n2. Use the findings in Create as the brief, then review the draft in Launch.\n3. Once a campaign is live, add an automation in Automations.\n\nOpen OrivenAI: ${ctx.appUrl}\nManage or cancel your subscription anytime in Settings → Subscription.` });
  },

  // Weekly AI Performance Report (service, Professional). Rendered ONLY from
  // the validated report (services/weeklyReport/metrics.js) and validated
  // insights; a metric that isn't reported reads "Not reported", never 0.
  weekly_report(d, ctx) { return weeklyReport(d, ctx); },

  // Priority Support: the team replied (service). The reply itself stays in
  // the app — the email only says there is one.
  support_reply(d, ctx) {
    const L = wrCopy.copyFor(d.lang);
    const body = p(esc(L.supportBody)) + button(L.supportCta, d.url || ctx.appUrl);
    return make({ category: 'service', subject: L.supportSubject, eyebrow: 'Priority Support', heading: L.supportHeading, preheader: L.supportBody.slice(0, 140),
      body, ctx, why: L.supportWhy, lang: wrCopy.lang(d.lang), text: `${L.supportHeading}\n\n${L.supportBody}\n\n${L.supportCta}: ${d.url || ctx.appUrl}` });
  },
};

// ── Weekly report rendering ──────────────────────────────────────────
const wrCopy = require('../weeklyReport/copy');

function weeklyReport(d, ctx) {
  const code = wrCopy.lang(d.lang), L = wrCopy.copyFor(code), locale = wrCopy.LOCALES[code];
  // Without a report (template previews) it renders the honest no-data email.
  const r = d.report || { period: { start: '1970-01-05', end: '1970-01-11', timeZone: 'Europe/Amsterdam' }, platforms: [], connected: 0, failed: [], needsReconnect: [], hasData: false, businessName: null };
  const dateFmt = (iso, year) => new Date(iso + 'T12:00:00Z').toLocaleDateString(locale, { day: 'numeric', month: 'long', year: year ? 'numeric' : undefined, timeZone: 'UTC' });
  const vars = { start: dateFmt(r.period.start, false), end: dateFmt(r.period.end, true), biz: r.businessName ? esc(r.businessName) : '' };
  const intFmt = (v) => Number(v).toLocaleString(locale, { maximumFractionDigits: 0 });
  const decFmt = (v) => Number(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (v, cur) => Number(v).toLocaleString(locale, { style: 'currency', currency: cur });
  const fmtVal = (k, v, cur) => {
    if (v == null) return null;
    if (k === 'spend' || k === 'cpc') return cur ? money(v, cur) : null;
    if (k === 'ctr') return decFmt(v) + '%';
    if (k === 'roas') return decFmt(v) + '×';
    if (k === 'conversions') return Number.isInteger(v) ? intFmt(v) : decFmt(v);
    return intFmt(v);
  };
  const fmtChange = (v) => (v == null ? '' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString(locale, { maximumFractionDigits: 1 }) + '%');
  const statusLabel = { not_connected: L.notConnected, reconnect: L.reconnect, failed: L.failed };
  const KEYS = ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'conversions', 'roas', 'reach'];
  const ok = r.platforms.filter((pl) => pl.status === 'ok');
  const withData = ok.filter((pl) => pl.hasData);
  const cell = (t, extra) => `<td style="padding:8px 0;border-bottom:1px solid ${C.line};font-family:${SANS};font-size:14px;line-height:1.4;color:${C.body}${extra || ''}">${t}</td>`;
  const txt = [];

  let body = '';
  const heading = r.hasData ? L.heading : L.noDataHeading;
  if (r.hasData) {
    body += p(wrCopy.fill(r.businessName ? L.introBiz : L.intro, vars));
    txt.push(wrCopy.fill(r.businessName ? L.introBiz : L.intro, Object.assign({}, vars, { biz: r.businessName || '' })), '');
  } else {
    const msg = wrCopy.fill(r.connected ? L.noDataQuiet : L.noDataNone, vars);
    body += p(esc(msg)); txt.push(msg, '');
  }

  // Per-platform metric tables (connected platforms with data or no delivery).
  for (const pl of ok) {
    const name = wrCopy.PLATFORM_NAMES[pl.platform];
    const cur = pl.account.currency;
    const title = `${name}${pl.account.name ? ' · ' + esc(pl.account.name) : ''}${cur ? ' · ' + cur : ''}`;
    if (!pl.hasData) { body += panel(title, p(esc(L.noActivity), 'margin-bottom:8px;font-size:15px')); txt.push(`${name}: ${L.noActivity}`); continue; }
    let rows = '';
    txt.push(`${name}${pl.account.name ? ' · ' + pl.account.name : ''}${cur ? ' · ' + cur : ''}`);
    for (const k of KEYS) {
      if (k === 'reach' && !pl.reported.includes('reach')) continue;
      if (k === 'roas' && pl.totals.roas == null) continue;
      const v = fmtVal(k, pl.totals[k], cur);
      const ch = pl.comparison === 'available' ? fmtChange(pl.changes[k]) : '';
      rows += `<tr>${cell(esc(L[k]))}${cell(v == null ? `<span style="color:${C.muted}">${esc(L.notReported)}</span>` : `<strong style="color:${C.ink}">${esc(v)}</strong>`, ';text-align:right')}${cell(ch ? esc(ch) : '', `;text-align:right;color:${C.muted};width:90px`)}</tr>`;
      txt.push(`- ${L[k]}: ${v == null ? L.notReported : v}${ch ? ' (' + ch + ' ' + L.vsPrev + ')' : ''}`);
    }
    rows += `<tr>${cell(esc(L.delivery))}${cell(`<strong style="color:${C.ink}">${intFmt(pl.totals.campaignsWithDelivery)}</strong>`, ';text-align:right')}${cell('')}</tr>`;
    txt.push(`- ${L.delivery}: ${pl.totals.campaignsWithDelivery}`);
    let inner = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${pl.comparison === 'available' ? `<tr>${cell('', ';border-bottom:0')}${cell('', ';border-bottom:0')}${cell(`<span style="font-size:12px">${esc(L.vsPrev)}</span>`, `;border-bottom:0;text-align:right;color:${C.muted}`)}</tr>` : ''}${rows}</table>`;
    if (pl.comparison !== 'available') { inner += small(esc(L.noComparison)); txt.push(L.noComparison); }
    if (pl.currencyMissing) { inner += small(esc(L.currencyMissing)); txt.push(L.currencyMissing); }
    const list = (label, items, why) => items.length
      ? `<p style="margin:16px 0 6px;font-family:${SANS};font-size:13px;font-weight:600;color:${C.ink}">${esc(label)}</p>` +
        items.map((c) => `<p style="margin:0 0 6px;font-family:${SANS};font-size:14px;line-height:1.45;color:${C.body}">${esc(c.name)}<span style="color:${C.muted}"> · ${[why ? why(c) : null, c.spend != null && cur ? money(c.spend, cur) : null, c.clicks != null ? intFmt(c.clicks) + ' ' + L.clicks.toLowerCase() : null, c.conversions ? fmtVal('conversions', c.conversions) + ' ' + L.conversions.toLowerCase() : null].filter(Boolean).map(esc).join(' · ')}</span></p>`).join('')
      : '';
    inner += list(L.performingWell, pl.top);
    inner += list(L.needsAttention, pl.attention, (c) => (c.reason === 'spend_no_clicks' ? L.spendNoClicks : L.lowCtr));
    pl.top.forEach((c) => txt.push(`  ${L.performingWell}: ${c.name}`));
    pl.attention.forEach((c) => txt.push(`  ${L.needsAttention}: ${c.name} (${c.reason === 'spend_no_clicks' ? L.spendNoClicks : L.lowCtr})`));
    body += panel(title, inner);
    txt.push('');
  }

  // Platforms without data this week (not connected / reconnect / failed).
  const others = r.platforms.filter((pl) => pl.status !== 'ok');
  if (others.length && (r.connected || r.hasData || r.failed.length || r.needsReconnect.length)) {
    body += others.map((pl) => small(`${esc(wrCopy.PLATFORM_NAMES[pl.platform])}: ${esc(statusLabel[pl.status] || L.notConnected)}`)).join('');
    others.forEach((pl) => txt.push(`${wrCopy.PLATFORM_NAMES[pl.platform]}: ${statusLabel[pl.status] || L.notConnected}`));
  }

  // AI insights (validated) — or an honest note that there are none.
  if (r.hasData) {
    const ins = d.insights;
    if (ins) {
      const sec = (label, items) => items && items.length ? `<p style="margin:14px 0 6px;font-family:${SANS};font-size:13px;font-weight:600;color:${C.ink}">${esc(label)}</p>` + items.map((t) => `<p style="margin:0 0 6px;font-family:${SANS};font-size:14px;line-height:1.5;color:${C.body}">• ${esc(t)}</p>`).join('') : '';
      const inner = (ins.summary ? p(esc(ins.summary), 'font-size:15px') : '') + sec(L.performingWell, ins.wentWell) + sec(L.needsAttention, ins.needsAttention) + sec(L.opportunities, ins.opportunities) + sec(L.nextSteps, ins.actions) + small(esc(L.aiNote));
      body += panel(L.insights, inner);
      txt.push(L.insights.toUpperCase());
      if (ins.summary) txt.push(ins.summary);
      [[L.performingWell, ins.wentWell], [L.needsAttention, ins.needsAttention], [L.opportunities, ins.opportunities], [L.nextSteps, ins.actions]].forEach(([lbl, items]) => { if (items && items.length) { txt.push(lbl + ':'); items.forEach((t) => txt.push('- ' + t)); } });
      txt.push(L.aiNote, '');
    } else { body += small(esc(L.aiUnavailable)); txt.push(L.aiUnavailable, ''); }
    if (withData.filter((pl) => pl.totals.conversions != null).length > 1) { body += small(esc(L.convNote)); txt.push(L.convNote); }
    if (withData.some((pl) => pl.totals.spend != null)) { body += small(esc(L.currencyNote)); txt.push(L.currencyNote); }
  }

  const ctaLabel = r.connected ? L.cta : L.connectCta;
  const ctaUrl = r.connected ? d.campaignsUrl : d.connectUrl;
  body += button(ctaLabel, ctaUrl || ctx.appUrl);
  const tzLine = wrCopy.fill(L.tz, { tz: r.period.timeZone });
  body += small(esc(tzLine) + (d.offUrl ? ' · ' + link(esc(L.off), d.offUrl) : ''));
  txt.push(`${ctaLabel}: ${ctaUrl || ctx.appUrl}`, tzLine);
  if (d.offUrl) txt.push(`${L.off}: ${d.offUrl}`);

  return make({ category: 'service', subject: r.hasData ? L.subject : L.noDataSubject, eyebrow: L.eyebrow, heading,
    preheader: wrCopy.fill(r.hasData ? L.intro : (r.connected ? L.noDataQuiet : L.noDataNone), Object.assign({}, vars, { biz: r.businessName || '' })).slice(0, 140),
    body, ctx, why: L.why, lang: code, text: `${heading}\n\n` + txt.join('\n') });
}

function render(key, data, ctx) {
  const t = TEMPLATES[key];
  if (!t) throw new Error('unknown email template: ' + key);
  return t(data || {}, ctx || {});
}

// ── Supabase Auth email templates ────────────────────────────────────
// Not sent by this server: Supabase Auth sends these (custom SMTP through
// Resend) and fills in its own Go-template variables. The HTML is pasted into
// Supabase → Authentication → Emails; scripts/supabase-email-templates.js
// writes it to docs/email/ so the dashboard copy can be compared with the
// source. {{ .ConfirmationURL }} is Supabase's one-time recovery link — the
// token, its expiry and single use stay entirely with Supabase.
const SUPABASE_URL_VAR = '{{ .ConfirmationURL }}';
const SUPABASE_AUTH = {
  reset_password() {
    const url = SUPABASE_URL_VAR;
    const body =
      p('We received a request to reset the password for your OrivenAI account.') +
      p('Choose a new password with the button below. For your security, the link can be used only once and expires after a short time.') +
      button('Reset Password', url) +
      small(`If the button doesn’t work, paste this address into your browser:<br><a href="${url}" style="color:${C.muted};word-break:break-all">${url}</a>`) +
      small('If you did not request this change, you can safely ignore this email. Your password stays the same.');
    return {
      subject: 'Reset your OrivenAI password',
      html: layout({ eyebrow: 'Your account', heading: 'Reset your password', preheader: 'A secure link to choose a new password for your OrivenAI account.',
        body, ctx: {}, category: 'service', why: 'You’re receiving this because a password reset was requested for this address on OrivenAI.' }),
    };
  },
};
function supabaseAuthTemplate(kind) {
  const t = SUPABASE_AUTH[kind];
  if (!t) throw new Error('unknown Supabase auth template: ' + kind);
  return t();
}

module.exports = { render, TEMPLATES, PLAN_INTRO, esc, supabaseAuthTemplate, SUPABASE_URL_VAR };
