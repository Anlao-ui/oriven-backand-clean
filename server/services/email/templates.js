// ── Lifecycle email templates ────────────────────────────────────────
//
// Six emails (see services/email/lifecycle.js for when each is sent).
// Every template returns { subject, html, text, category }:
//   category 'service'   — account / purchase information; sent without
//                          marketing consent, never contains promotion;
//   category 'marketing' — lifecycle encouragement; only with marketing
//                          consent, always with an unsubscribe link.
//
// Brand: OrivenAI lime (#B7FF2A) on near-black buttons-text, warm off-white
// page (#F6F3EE), charcoal text (#18181A), muted (#6B6B6B), the public logo
// (https://orivenai.com/assets/orivenlogo.png). Table layout and inline
// styles so it renders in Outlook/Gmail; 560px column, fluid on mobile.
// Copy: short and concrete — no urgency, no claims the product can't back.

const C = { bg: '#F6F3EE', card: '#FFFFFF', ink: '#18181A', muted: '#6B6B6B', line: '#E7E1D8', lime: '#B7FF2A', limeInk: '#0A0A0A' };
const LOGO = 'https://orivenai.com/assets/orivenlogo.png';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "'Instrument Serif',Georgia,'Times New Roman',serif";

function button(label, url) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 8px"><tr><td style="border-radius:10px;background:${C.lime}">` +
    `<a href="${esc(url)}" style="display:inline-block;padding:13px 22px;font-family:${SANS};font-size:15px;font-weight:600;color:${C.limeInk};text-decoration:none;border-radius:10px">${esc(label)}</a></td></tr></table>`;
}
const p = (t) => `<p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.6;color:${C.ink}">${t}</p>`;
const small = (t) => `<p style="margin:0 0 10px;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.muted}">${t}</p>`;
function list(items) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 14px">` +
    items.map((i) => `<tr><td valign="top" style="padding:0 10px 8px 0;font-family:${SANS};font-size:15px;color:${C.ink}">&#8226;</td><td style="padding:0 0 8px;font-family:${SANS};font-size:15px;line-height:1.55;color:${C.ink}">${i}</td></tr>`).join('') +
    `</table>`;
}

// ctx: { appUrl, unsubscribeUrl?, postalAddress?, preheader? }
function layout({ heading, body, ctx, category, why }) {
  const footer =
    small(esc(why)) +
    (category === 'marketing' && ctx.unsubscribeUrl
      ? small(`Don’t want these emails? <a href="${esc(ctx.unsubscribeUrl)}" style="color:${C.muted};text-decoration:underline">Unsubscribe</a>. Account and billing emails will still reach you.`)
      : '') +
    small(`OrivenAI${ctx.postalAddress ? ' · ' + esc(ctx.postalAddress) : ''} · <a href="mailto:contact@orivenai.com" style="color:${C.muted}">contact@orivenai.com</a>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(heading)}</title></head>` +
    `<body style="margin:0;padding:0;background:${C.bg}">` +
    (ctx.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(ctx.preheader)}</div>` : '') +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.bg}"><tr><td align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px">` +
    `<tr><td style="padding:0 4px 18px"><img src="${LOGO}" width="32" height="32" alt="OrivenAI" style="display:inline-block;vertical-align:middle;border:0">` +
    `<span style="display:inline-block;vertical-align:middle;margin-left:10px;font-family:${SANS};font-size:15px;font-weight:700;color:${C.ink};letter-spacing:.2px">OrivenAI</span></td></tr>` +
    `<tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:32px 28px">` +
    `<h1 style="margin:0 0 16px;font-family:${SERIF};font-weight:400;font-size:28px;line-height:1.2;color:${C.ink}">${esc(heading)}</h1>` +
    body +
    `</td></tr><tr><td style="padding:20px 4px 0">${footer}</td></tr></table></td></tr></table></body></html>`;
}

const PLAN_INTRO = {
  starter: { name: 'Starter', unlocks: ['Research: investigate your market, competitors and audience', 'Autopilot: rules that watch your campaigns', '1.000 credits a month for Create, Research and more'] },
  creator: { name: 'Creator', unlocks: ['Everything in Starter', 'Oriven Chat, your advertising assistant inside the app', '2.500 credits a month'] },
  professional: { name: 'Professional', unlocks: ['Everything in Creator', 'Notifications and Priority Support', '4.000 credits a month'] },
};

const TEMPLATES = {
  // Email address verification (transactional — sent right after signup and
  // on "resend", regardless of marketing consent). services/email/verification.js
  verify_email(d, ctx) {
    const name = d.firstName ? `, ${esc(d.firstName)}` : '';
    const days = d.validDays || 14;
    const body =
      p(`Hi${name}. Please confirm that this is your email address, so we can reach you about your account.`) +
      button('Confirm my email', d.verifyUrl) +
      small(`The link is valid for ${days} days. If you didn’t create an OrivenAI account, you can ignore this email.`);
    return { category: 'service', subject: 'Confirm your email for OrivenAI',
      html: layout({ heading: 'Confirm your email', body, ctx, category: 'service', why: 'You’re receiving this because this address was used to create an OrivenAI account.' }),
      text: `Hi${d.firstName ? ' ' + d.firstName : ''},\n\nConfirm your email for OrivenAI (valid ${days} days):\n${d.verifyUrl}\n\nIf you didn’t create an OrivenAI account, you can ignore this email.\n\n— OrivenAI` };
  },

  // 1 — Welcome (service). Carries the verification link when one is pending,
  // so a new user gets one email, not two.
  welcome(d, ctx) {
    const name = d.firstName ? `, ${d.firstName}` : ''; // layout() escapes the heading
    const body =
      p(`Your OrivenAI workspace is ready. It’s built around one path: understand your market, create ads, launch them and see what works.`) +
      (d.verifyUrl ? p(`First, confirm this is your email address:`) + button('Confirm my email', d.verifyUrl) + small(`The link is valid for 14 days.`) : '') +
      p(`When you sign in, pick where you want to start: create your first ad, research your market, or look around.`) +
      // One primary action per email: when confirming is the ask, the app link is secondary.
      (d.verifyUrl ? p(`<a href="${esc(ctx.appUrl)}" style="color:${C.ink};font-weight:600">Open OrivenAI &rarr;</a>`) : button('Open OrivenAI', ctx.appUrl));
    return { category: 'service', subject: 'Welcome to OrivenAI', html: layout({ heading: `Welcome${name}`, body, ctx, category: 'service', why: 'You’re receiving this because you created an OrivenAI account.' }),
      text: `Welcome${d.firstName ? ', ' + d.firstName : ''}\n\nYour OrivenAI workspace is ready.\n\n${d.verifyUrl ? 'Confirm your email (valid 14 days): ' + d.verifyUrl + '\n\n' : ''}Open OrivenAI: ${ctx.appUrl}\n\n— OrivenAI` };
  },

  // 2 — First-ad reminder (marketing). Mentions the free first ad only when
  // the server says the account still has it.
  first_ad_reminder(d, ctx) {
    const body =
      p(`You haven’t created your first ad yet. It takes a few minutes: describe what you sell and who it’s for, pick a platform, and OrivenAI writes the campaign: headlines, ad copy, targeting and visual concepts.`) +
      (d.freeFirstAd ? p(`Your first complete ad, including its image, is free.`) : p(`On the Free plan you can build one campaign a day.`)) +
      button('Create my first ad', ctx.appUrl + '?start=create');
    return { category: 'marketing', subject: d.freeFirstAd ? 'Your first ad is ready to make (and free)' : 'Your first ad is a few minutes away',
      html: layout({ heading: 'Ready for your first ad?', body, ctx, category: 'marketing', why: 'You’re receiving this because you signed up for OrivenAI and agreed to product emails.' }),
      text: `Ready for your first ad?\n\nDescribe what you sell and who it’s for, pick a platform, and OrivenAI writes the campaign.\n${d.freeFirstAd ? 'Your first complete ad, including its image, is free.\n' : ''}\nCreate my first ad: ${ctx.appUrl}?start=create\n\nUnsubscribe: ${ctx.unsubscribeUrl || ''}` };
  },

  // 3 — First success (marketing). One next step, depending on what they did.
  first_success(d, ctx) {
    const research = d.kind === 'research';
    const body = research
      ? p(`Your first Research is done. The next step is to turn it into an ad: in Create, your findings can be used as the brief, so the copy speaks to the audience and gaps you found.`) + button('Turn it into an ad', ctx.appUrl + '?start=create')
      : p(`Your first ad is built. A good next step is Research: see who you’re really competing with and what they promise, then sharpen your next ad with it.`) + (d.researchIncluded ? '' : small(`Research is included from Starter.`)) + button('Explore Research', ctx.appUrl + '?start=research');
    return { category: 'marketing', subject: research ? 'Your research is ready, now put it to work' : 'Your first ad is ready. Here’s a good next step',
      html: layout({ heading: research ? 'Nice work on your first research' : 'Your first ad is ready', body, ctx, category: 'marketing', why: 'You’re receiving this because you agreed to product emails from OrivenAI.' }),
      text: (research ? 'Your first Research is done. Turn it into an ad: ' + ctx.appUrl + '?start=create' : 'Your first ad is built. Next: Research your market: ' + ctx.appUrl + '?start=research') + `\n\nUnsubscribe: ${ctx.unsubscribeUrl || ''}` };
  },

  // 4 — Inactive (marketing).
  inactive(d, ctx) {
    const body =
      p(`It’s been a while since you used OrivenAI. A quick reminder of what it does for you:`) +
      list(['Research your market and competitors before you spend on ads', 'Create campaign copy, targeting and visuals for Google, Meta, TikTok and Pinterest', 'Launch and follow your campaigns from one place']) +
      button('Pick up where you left off', ctx.appUrl);
    return { category: 'marketing', subject: 'Your OrivenAI workspace is still here',
      html: layout({ heading: 'Your workspace is still here', body, ctx, category: 'marketing', why: 'You’re receiving this because you agreed to product emails from OrivenAI.' }),
      text: `Your OrivenAI workspace is still here.\n\nOpen it: ${ctx.appUrl}\n\nUnsubscribe: ${ctx.unsubscribeUrl || ''}` };
  },

  // 5 — Upgrade education (marketing). Explains, factually, what the plan
  // that covers their repeated blocked action includes.
  upgrade_education(d, ctx) {
    const plan = PLAN_INTRO[d.plan] || PLAN_INTRO.starter;
    const what = d.action === 'research' ? 'Research' : d.action === 'image' ? 'ad images' : 'more campaign builds';
    const body =
      p(`You’ve tried to use ${esc(what)} a few times on the Free plan. Here’s what ${plan.name} includes${d.price ? ` (€${esc(d.price)}/month, cancel anytime)` : ''}:`) +
      list(plan.unlocks.map(esc)) +
      p(`If Free works for you, there’s nothing you need to do.`) +
      button(`See ${plan.name}`, ctx.appUrl + '?plans=1');
    return { category: 'marketing', subject: `What ${plan.name} adds to OrivenAI`,
      html: layout({ heading: `What ${plan.name} includes`, body, ctx, category: 'marketing', why: 'You’re receiving this because you agreed to product emails from OrivenAI.' }),
      text: `What ${plan.name} includes:\n- ${plan.unlocks.join('\n- ')}\n\nSee plans: ${ctx.appUrl}?plans=1\n\nUnsubscribe: ${ctx.unsubscribeUrl || ''}` };
  },

  // 6 — Paid customer onboarding (service). Only what the plan really has.
  paid_onboarding(d, ctx) {
    const plan = PLAN_INTRO[d.plan] || PLAN_INTRO.starter;
    const body =
      p(`Thanks for subscribing to ${plan.name}. Your plan is active. Here’s what it gives you:`) +
      list(plan.unlocks.map(esc)) +
      p(`A good first step: run a Research on your market, then use it as the brief for your next ad in Create.`) +
      button('Open OrivenAI', ctx.appUrl) +
      small(`Manage or cancel your subscription anytime in Settings → Subscription.`);
    return { category: 'service', subject: `Your ${plan.name} plan is active`,
      html: layout({ heading: `Welcome to ${plan.name}`, body, ctx, category: 'service', why: `You’re receiving this because you subscribed to OrivenAI ${plan.name}.` }),
      text: `Your ${plan.name} plan is active.\n- ${plan.unlocks.join('\n- ')}\n\nOpen OrivenAI: ${ctx.appUrl}\nManage your subscription in Settings → Subscription.` };
  },
};

function render(key, data, ctx) {
  const t = TEMPLATES[key];
  if (!t) throw new Error('unknown email template: ' + key);
  return t(data || {}, ctx || {});
}

module.exports = { render, TEMPLATES, PLAN_INTRO, esc };
