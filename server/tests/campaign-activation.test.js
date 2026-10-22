// ════════════════════════════════════════════════════════════════
// Campaign activation (Launch → Activate) for Meta, TikTok and Pinterest.
// Publishing creates the campaign, its ad sets / ad groups and its ads
// paused; the first activation must switch on exactly the objects OrivenAI
// created — ads, then ad sets, the campaign last — and report honestly what
// is still paused.
//
// Runs the REAL server.js through tests/helpers/mockServer.js: Supabase is
// an in-memory mock, every outbound request is blocked except the fake
// Meta / TikTok / Pinterest APIs below (in-process functions — nothing is
// sent anywhere). No real accounts, no real campaigns.
// RUN: node tests/campaign-activation.test.js   (from server/)
// ════════════════════════════════════════════════════════════════
const { boot, reporter } = require('./helpers/mockServer');
const H = boot({ port: 5641, env: { ACTIVATION_STEP_TIMEOUT_MS: '400', ORIVEN_TEST_HOOKS: '1' } });
const { check, log, done } = reporter();

const U = { id: '00000000-0000-4000-8000-00000000ac71', email: 'activate@example.invalid' };
const TOK = 'tok_activation';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });

// ── Fake providers ───────────────────────────────────────────────────
let P; // provider state, reset per scenario
function reset() {
  P = {
    calls: [], // [platform, kind, id] for every MUTATION, in order
    reads: 0,
    meta: { owner: { 2001: '111' }, campaign: { 2001: 'PAUSED' }, sets: {}, ads: {}, failIds: {}, hangIds: {}, delay: 0, listFailAfterCampaign: false, campaignOn: false },
    tiktok: { campaigns: { 3001: 'DISABLE' }, groups: {}, ads: {}, failPath: null },
    pinterest: { campaigns: { 4001: 'PAUSED' }, groups: {}, ads: {}, exceptionIds: {} },
  };
}
reset();
function metaRows(map) { return Object.keys(map).map((id) => ({ id, status: map[id] })); }

H.net.handler = async (url, opts) => {
  const u = new URL(url);
  const method = (opts && opts.method) || 'GET';
  // ── Meta Graph API ──
  if (u.host === 'graph.facebook.com') {
    const m = P.meta;
    const parts = u.pathname.split('/').filter(Boolean); // [version, id, edge?]
    const id = parts[1], edge = parts[2];
    if (method === 'GET') {
      P.reads++;
      if (/^act_/.test(id)) return json({ id, account_status: 1 });
      if (edge === 'adsets' || edge === 'ads') {
        if (m.listFailAfterCampaign && m.campaignOn) return json({ error: { message: 'Temporarily unavailable', code: 2 } }, 500);
        return json({ data: metaRows(edge === 'adsets' ? m.sets : m.ads) });
      }
      if (m.owner[id] != null) return json({ id, name: 'Spring', status: m.campaign[id] || 'PAUSED', account_id: m.owner[id] });
      return json({ error: { message: 'Unsupported get request. Object does not exist', code: 100 } }, 400);
    }
    // POST /{id}  status=ACTIVE|PAUSED (form body)
    const body = new URLSearchParams(String(opts.body || ''));
    const status = body.get('status');
    if (m.delay) await sleep(m.delay);
    if (m.hangIds[id]) await sleep(m.hangIds[id]);
    if (m.failIds[id]) return json({ error: { message: 'Mock refusal for ' + id, code: 100 } }, 400);
    const kind = m.campaign[id] != null ? 'campaign' : m.sets[id] != null ? 'adset' : m.ads[id] != null ? 'ad' : 'unknown';
    P.calls.push(['meta', kind, id, status]);
    if (kind === 'campaign') { m.campaign[id] = status; if (status === 'ACTIVE') m.campaignOn = true; }
    else if (kind === 'adset') m.sets[id] = status; else if (kind === 'ad') m.ads[id] = status;
    return json({ success: true });
  }
  // ── TikTok Business API ──
  if (u.host === 'business-api.tiktok.com') {
    const t = P.tiktok;
    const path = u.pathname.replace('/open_api/v1.3', '');
    if (method === 'GET') {
      P.reads++;
      const f = JSON.parse(u.searchParams.get('filtering') || '{}');
      const cids = (f.campaign_ids || []).map(String);
      if (path === '/campaign/get/') return json({ code: 0, data: { list: cids.filter((c) => t.campaigns[c] != null).map((c) => ({ campaign_id: c, campaign_name: 'Spring', operation_status: t.campaigns[c] })) } });
      if (path === '/advertiser/info/') return json({ code: 0, data: { list: [{ advertiser_id: '7001', currency: 'USD', timezone: 'Etc/UTC' }] } });
      if (path === '/adgroup/get/') return json({ code: 0, data: { list: Object.keys(t.groups).map((id) => ({ adgroup_id: id, operation_status: t.groups[id] })) } });
      if (path === '/ad/get/') return json({ code: 0, data: { list: Object.keys(t.ads).map((id) => ({ ad_id: id, operation_status: t.ads[id] })) } });
    }
    const b = JSON.parse(String(opts.body || '{}'));
    if (t.failPath === path) return json({ code: 40002, message: 'Mock: no permission for this object' });
    const map = path === '/ad/status/update/' ? ['ad', 'ad_ids', t.ads] : path === '/adgroup/status/update/' ? ['adgroup', 'adgroup_ids', t.groups] : ['campaign', 'campaign_ids', t.campaigns];
    (b[map[1]] || []).forEach((id) => { P.calls.push(['tiktok', map[0], String(id), b.operation_status]); map[2][id] = b.operation_status; });
    return json({ code: 0, data: {} });
  }
  // ── Pinterest API v5 ──
  if (u.host === 'api.pinterest.com') {
    const pi = P.pinterest;
    if (method === 'GET' && /^\/v5\/ad_accounts\/[^/]+$/.test(u.pathname)) return json({ id: 'pa1', currency: 'USD' });
    const one = u.pathname.match(/^\/v5\/ad_accounts\/([^/]+)\/campaigns\/(\d+)$/);
    if (one && method === 'GET') return pi.campaigns[one[2]] != null && one[1] === 'pa1' ? json({ id: one[2], name: 'Spring', status: pi.campaigns[one[2]] }) : json({ message: 'not found' }, 404);
    const m = u.pathname.match(/^\/v5\/ad_accounts\/([^/]+)\/(campaigns|ad_groups|ads)$/);
    if (!m) return json({ message: 'not mocked' }, 404);
    const store = m[2] === 'campaigns' ? pi.campaigns : m[2] === 'ad_groups' ? pi.groups : pi.ads;
    if (method === 'GET') {
      P.reads++;
      if (m[1] !== 'pa1') return json({ items: [] });
      if (m[2] === 'campaigns') { const want = String(u.searchParams.get('campaign_ids') || ''); return json({ items: store[want] != null ? [{ id: want, status: store[want] }] : [] }); }
      return json({ items: Object.keys(store).map((id) => ({ id, status: store[id] })) });
    }
    const items = JSON.parse(String(opts.body || '[]'));
    return json({ items: items.map((it) => {
      if (pi.exceptionIds[it.id]) return { data: { id: it.id }, exceptions: [{ code: 2, message: 'Mock: not allowed' }] };
      P.calls.push(['pinterest', m[2], String(it.id), it.status]); store[it.id] = it.status; return { data: { id: it.id, status: it.status }, exceptions: [] };
    }) });
  }
  return null; // anything else stays blocked
};

// ── Helpers ──────────────────────────────────────────────────────────
function seedIntegrations(opts) {
  opts = opts || {};
  const t = H.rows('integrations'); t.length = 0;
  const future = new Date(Date.now() + 864e5).toISOString(), past = new Date(Date.now() - 864e5).toISOString();
  t.push({ user_id: U.id, provider: 'meta_ads', access_token: 'meta-mock', token_expiry: opts.metaExpired ? past : future, active_ad_account: { account_id: '111', account_name: 'Linnen Meta' } });
  t.push({ user_id: U.id, provider: 'tiktok_ads', access_token: 'tt-mock', refresh_token: 'tt-r', token_expiry: future, active_ad_account: { account_id: '7001', account_name: 'Linnen TikTok' } });
  t.push({ user_id: U.id, provider: 'pinterest_ads', access_token: 'pin-mock', refresh_token: 'pin-r', token_expiry: future, active_ad_account: { account_id: 'pa1', account_name: 'Linnen Pins' } });
}
function record(platform, campaignId, adSetIds, adIds, accountId) {
  const t = H.rows('publish_operations');
  for (let i = t.length - 1; i >= 0; i--) if (t[i].platform === platform && t[i].external_campaign_id === campaignId) t.splice(i, 1);
  if (adSetIds) t.push({ id: 'op-' + platform + campaignId, user_id: U.id, platform, client_ref_id: 'c-' + campaignId, state: 'published', external_campaign_id: campaignId, external_account_id: accountId, external_ids: { adSetIds, adIds } });
}
const activate = (platform, id, first) => H.call('POST', '/api/' + platform + '/campaign/' + id + '/resume', TOK, { campaignName: 'Spring', firstActivation: first !== false });
const mutations = (platform) => P.calls.filter((c) => c[0] === platform);

(async () => {
  const quiet = await H.start();
  H.TOKENS[TOK] = U;
  H.rows('profiles').push({ id: U.id, email: U.email, subscription_status: 'creator' });

  log('\nA. Meta — first activation switches on exactly what OrivenAI created');
  reset(); seedIntegrations();
  Object.assign(P.meta.sets, { 5001: 'PAUSED', 5002: 'PAUSED', 5099: 'PAUSED' });
  Object.assign(P.meta.ads, { 6001: 'PAUSED', 6002: 'PAUSED', 6099: 'PAUSED' });
  record('meta', '2001', ['5001', '5002'], ['6001', '6002'], 'act_111');
  let r = await activate('meta', '2001');
  const order = mutations('meta').map((c) => c[1] + ':' + c[2]);
  check('200 ok, campaign ACTIVE', r.status === 200 && r.body.ok === true && P.meta.campaign['2001'] === 'ACTIVE', r.body);
  check('order: ads → ad sets → campaign last', JSON.stringify(order) === JSON.stringify(['ad:6001', 'ad:6002', 'adset:5001', 'adset:5002', 'campaign:2001']), order);
  check('ad set 5099 / ad 6099 (not created by OrivenAI) stay paused', P.meta.sets['5099'] === 'PAUSED' && P.meta.ads['6099'] === 'PAUSED');
  check('report: state active, verified, nothing of OrivenAI’s left paused, 1+1 preserved', r.body.activation.state === 'active' && r.body.activation.verified === true && r.body.activation.remainingPaused.ads.length === 0 && r.body.activation.preservedPaused.adSets === 1 && r.body.activation.preservedPaused.ads === 1, r.body.activation);

  log('\nB. Meta — resume after a pause keeps an ad set the advertiser paused');
  P.calls = []; P.meta.campaign['2001'] = 'PAUSED'; P.meta.sets['5002'] = 'PAUSED';
  r = await activate('meta', '2001', false);
  check('only the campaign is switched on', JSON.stringify(mutations('meta').map((c) => c[1])) === JSON.stringify(['campaign']) && P.meta.sets['5002'] === 'PAUSED', mutations('meta'));
  check('report: partial — names the paused ad sets (5002, 5099), never "active"', r.body.activation.state === 'partial' && r.body.activation.remainingPaused.adSets.indexOf('5002') !== -1, r.body.activation);

  log('\nC. Meta — a failed ad stops activation; the campaign stays paused');
  reset(); seedIntegrations();
  Object.assign(P.meta.sets, { 5001: 'PAUSED' }); Object.assign(P.meta.ads, { 6001: 'PAUSED', 6002: 'PAUSED' }); P.meta.failIds['6002'] = true;
  record('meta', '2001', ['5001'], ['6001', '6002'], 'act_111');
  r = await activate('meta', '2001');
  check('502 ACTIVATION_INCOMPLETE at the ads step', r.status === 502 && r.body.code === 'ACTIVATION_INCOMPLETE' && r.body.step === 'ads', r.body);
  check('report: 6001 switched on, 6002 failed; campaign untouched and paused', JSON.stringify(r.body.activation.enabled.ads) === '["6001"]' && JSON.stringify(r.body.activation.failed.ads) === '["6002"]' && P.meta.campaign['2001'] === 'PAUSED' && !mutations('meta').some((c) => c[1] === 'campaign'), r.body.activation);
  check('says nothing is spending', /Nothing is spending/.test(r.body.error), r.body.error);

  log('\nD. Meta — the campaign itself fails after the children');
  reset(); seedIntegrations();
  Object.assign(P.meta.sets, { 5001: 'PAUSED' }); Object.assign(P.meta.ads, { 6001: 'PAUSED' }); P.meta.failIds['2001'] = true;
  record('meta', '2001', ['5001'], ['6001'], 'act_111');
  r = await activate('meta', '2001');
  check('502 at the campaign step; children reported as switched on, campaign paused', r.status === 502 && r.body.step === 'campaign' && r.body.activation.enabled.ads.length === 1 && r.body.activation.campaign === 'paused' && P.meta.campaign['2001'] === 'PAUSED', r.body);

  log('\nE. Meta — a provider timeout');
  reset(); seedIntegrations();
  Object.assign(P.meta.ads, { 6001: 'PAUSED' }); P.meta.hangIds['6001'] = 1500;
  record('meta', '2001', [], ['6001'], 'act_111');
  r = await activate('meta', '2001');
  check('timeout → 502 ACTIVATION_INCOMPLETE, timeout flagged, campaign not switched on', r.status === 502 && r.body.timeout === true && P.meta.campaign['2001'] === 'PAUSED', r.body);
  await sleep(1300);

  log('\nF. Meta — duplicate activation requests');
  reset(); seedIntegrations();
  Object.assign(P.meta.ads, { 6001: 'PAUSED' }); P.meta.delay = 150;
  record('meta', '2001', [], ['6001'], 'act_111');
  const both = await Promise.all([activate('meta', '2001'), activate('meta', '2001')]);
  const codes = both.map((x) => x.status).sort();
  check('one runs, the other → 409 ACTIVATION_IN_PROGRESS', JSON.stringify(codes) === '[200,409]' && both.some((x) => x.body.code === 'ACTIVATION_IN_PROGRESS'), both.map((x) => x.body.code || x.status));
  check('the campaign is switched on exactly once', mutations('meta').filter((c) => c[1] === 'campaign').length === 1, mutations('meta'));

  log('\nG. Meta — refusals before any change');
  reset(); seedIntegrations({ metaExpired: true });
  r = await activate('meta', '2001');
  check('expired Meta login → 409 RECONNECT_REQUIRED (not "session expired"), nothing changed', r.status === 409 && r.body.code === 'RECONNECT_REQUIRED' && !P.calls.length, r.body);
  reset(); seedIntegrations();
  P.meta.owner['2002'] = '999'; P.meta.campaign['2002'] = 'PAUSED';
  r = await activate('meta', '2002');
  check('campaign in another ad account → 404 CAMPAIGN_NOT_FOUND, nothing changed', r.status === 404 && r.body.code === 'CAMPAIGN_NOT_FOUND' && !P.calls.length, r.body);
  r = await activate('meta', '2077');
  check('unknown campaign id → 404 CAMPAIGN_NOT_FOUND, nothing changed', r.status === 404 && r.body.code === 'CAMPAIGN_NOT_FOUND' && !P.calls.length, r.body);
  Object.assign(P.meta.ads, { 6001: 'PAUSED' });
  record('meta', '2001', [], ['6001'], 'act_555');
  r = await activate('meta', '2001');
  check('publish record from another ad account → 409 WRONG_ACCOUNT, nothing changed', r.status === 409 && r.body.code === 'WRONG_ACCOUNT' && !P.calls.length, r.body);

  log('\nH. Meta — missing children, no record, unverifiable read-back');
  reset(); seedIntegrations();
  Object.assign(P.meta.ads, { 6001: 'PAUSED' });
  record('meta', '2001', [], ['6001', '6404'], 'act_111');
  r = await activate('meta', '2001');
  check('recorded ad no longer on Meta → reported as missing; the rest goes on', r.status === 200 && JSON.stringify(r.body.activation.missing.ads) === '["6404"]' && P.meta.ads['6001'] === 'ACTIVE', r.body.activation);
  reset(); seedIntegrations(); record('meta', '2001', null);
  Object.assign(P.meta.sets, { 5001: 'PAUSED' }); Object.assign(P.meta.ads, { 6001: 'PAUSED' });
  r = await activate('meta', '2001');
  check('no publish record → no child touched; campaign on; state partial listing what is paused', r.status === 200 && P.meta.ads['6001'] === 'PAUSED' && P.meta.sets['5001'] === 'PAUSED' && r.body.activation.state === 'partial' && r.body.activation.scope === 'none' && r.body.activation.remainingPaused.ads[0] === '6001', r.body.activation);
  reset(); seedIntegrations(); P.meta.listFailAfterCampaign = true;
  Object.assign(P.meta.ads, { 6001: 'PAUSED' }); record('meta', '2001', [], ['6001'], 'act_111');
  r = await activate('meta', '2001');
  check('read-back fails after switching on → state "unverified" (never "active")', r.status === 200 && r.body.activation.state === 'unverified' && r.body.activation.verified === false, r.body.activation);

  log('\nI. TikTok');
  reset(); seedIntegrations();
  Object.assign(P.tiktok.groups, { 8001: 'DISABLE', 8099: 'DISABLE' }); Object.assign(P.tiktok.ads, { 9001: 'DISABLE' });
  record('tiktok', '3001', ['8001'], ['9001'], '7001');
  r = await activate('tiktok', '3001');
  check('TikTok: ad → ad group → campaign, ENABLE; unrecorded ad group stays DISABLE', r.status === 200 && JSON.stringify(mutations('tiktok').map((c) => c[1] + ':' + c[2] + ':' + c[3])) === JSON.stringify(['ad:9001:ENABLE', 'adgroup:8001:ENABLE', 'campaign:3001:ENABLE']) && P.tiktok.groups['8099'] === 'DISABLE', mutations('tiktok'));
  check('TikTok report: active and verified', r.body.activation.state === 'active' && r.body.activation.verified, r.body.activation);
  reset(); seedIntegrations();
  Object.assign(P.tiktok.groups, { 8001: 'DISABLE' }); Object.assign(P.tiktok.ads, { 9001: 'DISABLE' }); P.tiktok.failPath = '/adgroup/status/update/';
  record('tiktok', '3001', ['8001'], ['9001'], '7001');
  r = await activate('tiktok', '3001');
  check('TikTok: ad group refused → 502 at the adSets step, campaign stays DISABLE', r.status === 502 && r.body.step === 'adSets' && P.tiktok.campaigns['3001'] === 'DISABLE', r.body);
  reset(); seedIntegrations();
  r = await activate('tiktok', '3999');
  check('TikTok: campaign not in this advertiser → 404, nothing changed', r.status === 404 && r.body.code === 'CAMPAIGN_NOT_FOUND' && !P.calls.length, r.body);

  log('\nJ. Pinterest');
  reset(); seedIntegrations();
  Object.assign(P.pinterest.groups, { 10001: 'PAUSED' }); Object.assign(P.pinterest.ads, { 11001: 'PAUSED', 11002: 'PAUSED' });
  record('pinterest', '4001', ['10001'], ['11001', '11002'], 'pa1');
  r = await activate('pinterest', '4001');
  check('Pinterest: ads → ad groups → campaign, ACTIVE', r.status === 200 && JSON.stringify(mutations('pinterest').map((c) => c[1] + ':' + c[2])) === JSON.stringify(['ads:11001', 'ads:11002', 'ad_groups:10001', 'campaigns:4001']) && P.pinterest.campaigns['4001'] === 'ACTIVE', mutations('pinterest'));
  reset(); seedIntegrations();
  Object.assign(P.pinterest.groups, { 10001: 'PAUSED' }); Object.assign(P.pinterest.ads, { 11001: 'PAUSED', 11002: 'PAUSED' }); P.pinterest.exceptionIds['11002'] = true;
  record('pinterest', '4001', ['10001'], ['11001', '11002'], 'pa1');
  r = await activate('pinterest', '4001');
  check('Pinterest: one ad refused inside a 200 bulk answer → 502, that ad named, campaign stays PAUSED', r.status === 502 && JSON.stringify(r.body.activation.failed.ads) === '["11002"]' && P.pinterest.campaigns['4001'] === 'PAUSED', r.body);
  reset(); seedIntegrations();
  r = await activate('pinterest', '4999');
  check('Pinterest: campaign not in this ad account → 404, nothing changed', r.status === 404 && !P.calls.length, r.body);

  // ── Automations: the same activation, through the engine ──────────
  const E = () => global.__orivenTestHooks.automations.engine;
  const resetAuto = () => { ['automation_rules', 'automation_jobs', 'automation_executions', 'automation_notifications', 'automation_approvals', 'automation_settings'].forEach((t) => { H.rows(t).length = 0; }); delete process.env.AUTOMATIONS_KILL_SWITCH; };
  const schedRule = (extra) => H.rows('automation_rules').push(Object.assign({ id: 'r-sched', user_id: U.id, name: 'Start Spring', kind: 'schedule', enabled: true, status: 'active', platform: 'meta',
    schedule: { timezone: 'Europe/Amsterdam', items: [{ key: 'k1', action: 'activate', type: 'once', at: '2026-10-22T09:00' }] }, scope: { type: 'campaigns', campaign_ids: ['2001'] } }, extra || {}));
  const job = (id, extra) => H.rows('automation_jobs').push(Object.assign({ id, user_id: U.id, automation_id: 'r-sched', platform: 'meta', campaign_id: '2001', campaign_name: 'Spring', action: 'activate', status: 'scheduled',
    run_at: new Date(Date.now() - 60e3).toISOString(), local_time: '2026-10-22T09:00', timezone: 'Europe/Amsterdam', attempts: 0, idempotency_key: 'sched:r-sched:k1:' + id }, extra || {}));
  const exec = (platform, campaignId, action) => E().executeAction({ userId: U.id, platform, campaignId, action: action || 'activate', automationId: 'r-sched' });
  const ledgerRow = (platform, cid) => H.rows('publish_operations').find((r) => r.platform === platform && r.external_campaign_id === cid);

  log('\nL. Automations — scheduled first activation (Meta) uses Launch’s activation');
  reset(); seedIntegrations(); resetAuto(); schedRule(); job('j1');
  Object.assign(P.meta.sets, { 5001: 'PAUSED', 5099: 'PAUSED' }); Object.assign(P.meta.ads, { 6001: 'PAUSED', 6099: 'PAUSED' });
  record('meta', '2001', ['5001'], ['6001'], 'act_111');
  let out = await E().runDueJobs({ now: Date.now() });
  const exRow = H.rows('automation_executions').find((e) => e.job_id === 'j1');
  check('scheduled activate → ads, ad sets, campaign last; unrecorded ad set/ad untouched', JSON.stringify(mutations('meta').map((c) => c[1] + ':' + c[2])) === JSON.stringify(['ad:6001', 'adset:5001', 'campaign:2001']) && P.meta.sets['5099'] === 'PAUSED' && P.meta.ads['6099'] === 'PAUSED', mutations('meta'));
  check('execution history: completed, with what was switched on', exRow && exRow.status === 'completed' && exRow.new_value && exRow.new_value.activation && exRow.new_value.activation.enabled === 2 && exRow.new_value.activation.state === 'active', exRow);
  check('notification says it was switched on (scheduled_completed)', H.rows('automation_notifications').some((n) => n.kind === 'scheduled_completed'), H.rows('automation_notifications').map((n) => n.kind));
  check('the publish record is marked activated (later activations are resumes)', !!(ledgerRow('meta', '2001').external_ids || {}).activatedAt, ledgerRow('meta', '2001'));
  out = await E().runDueJobs({ now: Date.now() });
  check('running the scheduler again does nothing (job already done)', mutations('meta').length === 3 && !out.claimed, out);

  log('\nM. After the first activation every activation is a resume');
  P.calls = []; P.meta.campaign['2001'] = 'PAUSED'; P.meta.campaignOn = false; P.meta.ads['6001'] = 'PAUSED'; // advertiser paused the ad by hand
  let res = await exec('meta', '2001', 'resume');
  check('engine resume: only the campaign; the ad the advertiser paused stays paused → partial, named', JSON.stringify(mutations('meta').map((c) => c[1])) === '["campaign"]' && P.meta.ads['6001'] === 'PAUSED' && res.status === 'partial' && res.reason === 'activation_partial' && /3 of its ad sets and ads are still paused/.test(res.error) && res.next.activation.stillPaused === 3, res); // 6001 (paused by hand) + 5099/6099 (not OrivenAI's)
  P.calls = []; P.meta.campaign['2001'] = 'PAUSED';
  r = await activate('meta', '2001', true);
  check('Launch saying “first activation” can’t override the record: resume semantics, ad stays paused', r.status === 200 && P.meta.ads['6001'] === 'PAUSED' && r.body.activation.firstActivation === false, r.body.activation);

  log('\nN. Automations — TikTok and Pinterest first activation');
  reset(); seedIntegrations(); resetAuto(); schedRule({ platform: 'tiktok' });
  Object.assign(P.tiktok.groups, { 8001: 'DISABLE' }); Object.assign(P.tiktok.ads, { 9001: 'DISABLE' }); record('tiktok', '3001', ['8001'], ['9001'], '7001');
  res = await exec('tiktok', '3001');
  check('TikTok via Automations: ad → ad group → campaign, completed', res.status === 'completed' && JSON.stringify(mutations('tiktok').map((c) => c[1])) === '["ad","adgroup","campaign"]', { res, m: mutations('tiktok') });
  reset(); seedIntegrations(); resetAuto(); schedRule({ platform: 'pinterest' });
  Object.assign(P.pinterest.groups, { 10001: 'PAUSED' }); Object.assign(P.pinterest.ads, { 11001: 'PAUSED' }); record('pinterest', '4001', ['10001'], ['11001'], 'pa1');
  res = await exec('pinterest', '4001');
  check('Pinterest via Automations: ads → ad groups → campaign, completed', res.status === 'completed' && JSON.stringify(mutations('pinterest').map((c) => c[1])) === '["ads","ad_groups","campaigns"]', { res, m: mutations('pinterest') });

  log('\nO. Automations — refusals and partial outcomes');
  reset(); seedIntegrations(); resetAuto(); schedRule(); record('meta', '2001', null);
  Object.assign(P.meta.sets, { 5001: 'PAUSED' }); Object.assign(P.meta.ads, { 6001: 'PAUSED' });
  res = await exec('meta', '2001');
  check('no publish record → campaign on, no ad/ad set guessed, result PARTIAL “no_publish_record” (not completed)', res.status === 'partial' && res.reason === 'no_publish_record' && P.meta.ads['6001'] === 'PAUSED' && /no record/.test(res.error), res);
  reset(); seedIntegrations(); resetAuto(); schedRule(); job('j-part'); record('meta', '2001', null);
  Object.assign(P.meta.sets, { 5001: 'PAUSED' }); Object.assign(P.meta.ads, { 6001: 'PAUSED' });
  await E().runDueJobs({ now: Date.now() });
  const pEx = H.rows('automation_executions').find((e) => e.job_id === 'j-part'), pJob = H.rows('automation_jobs').find((j) => j.id === 'j-part');
  const pN = H.rows('automation_notifications').find((n) => n.kind === 'partial');
  check('scheduled, no publish record → history PARTIAL, job PARTIAL (not completed)', pEx && pEx.status === 'partial' && pEx.reason === 'no_publish_record' && pJob && pJob.status === 'partial', { pEx, pJob });
  check('…and the user gets a "partial" notification that says it is not fully delivering', pN && /not fully delivering/.test(pN.title) && /no record/.test(pN.body), H.rows('automation_notifications'));
  reset(); seedIntegrations(); resetAuto(); schedRule(); Object.assign(P.meta.ads, { 6001: 'PAUSED' }); record('meta', '2001', [], ['6001'], 'act_999');
  res = await exec('meta', '2001');
  check('record from another ad account → failed “wrong_account”, nothing changed', res.status === 'failed' && res.reason === 'wrong_account' && !P.calls.length, res);
  reset(); seedIntegrations(); resetAuto(); schedRule(); P.meta.owner['2002'] = '999'; P.meta.campaign['2002'] = 'PAUSED';
  res = await exec('meta', '2002');
  check('campaign in another ad account → failed “campaign_not_found”, nothing changed', res.status === 'failed' && res.reason === 'campaign_not_found' && !P.calls.length, res);
  reset(); seedIntegrations(); resetAuto(); schedRule(); Object.assign(P.meta.ads, { 6001: 'PAUSED', 6002: 'PAUSED' }); P.meta.failIds['6002'] = true; record('meta', '2001', [], ['6001', '6002'], 'act_111');
  res = await exec('meta', '2001');
  check('one ad refused → failed “activation_incomplete”, campaign stays paused, counts in the message', res.status === 'failed' && res.reason === 'activation_incomplete' && P.meta.campaign['2001'] === 'PAUSED' && /1 of its ads and ad sets were switched on, 1 couldn’t be/.test(res.error), res);
  reset(); seedIntegrations(); resetAuto(); schedRule(); job('j-to'); Object.assign(P.meta.ads, { 6001: 'PAUSED' }); P.meta.hangIds['6001'] = 1500; record('meta', '2001', [], ['6001'], 'act_111');
  await E().runDueJobs({ now: Date.now() });
  const jto = H.rows('automation_jobs').find((j) => j.id === 'j-to'), exTo = H.rows('automation_executions').find((e) => e.job_id === 'j-to');
  check('provider timeout → failed “activation_unconfirmed”, NOT rescheduled for an automatic retry', jto.status === 'failed' && exTo && exTo.reason === 'activation_unconfirmed' && P.meta.campaign['2001'] === 'PAUSED', { job: jto.status, ex: exTo && exTo.reason });
  check('…and the user is told (failed notification)', H.rows('automation_notifications').some((n) => n.kind === 'failed'), H.rows('automation_notifications').map((n) => n.kind));
  await sleep(1300);
  reset(); seedIntegrations(); resetAuto(); schedRule(); P.meta.listFailAfterCampaign = true; Object.assign(P.meta.ads, { 6001: 'PAUSED' }); record('meta', '2001', [], ['6001'], 'act_111');
  res = await exec('meta', '2001');
  check('read-back fails → PARTIAL “activation_unverified”, never completed', res.status === 'partial' && res.reason === 'activation_unverified', res);

  log('\nP. Automations — duplicates and races');
  reset(); seedIntegrations(); resetAuto(); schedRule(); job('j-dup'); Object.assign(P.meta.ads, { 6001: 'PAUSED' }); P.meta.delay = 120; record('meta', '2001', [], ['6001'], 'act_111');
  await Promise.all([E().runDueJobs({ now: Date.now() }), E().runDueJobs({ now: Date.now() })]);
  check('two schedulers at once → the job runs once, the campaign is switched on once', mutations('meta').filter((c) => c[1] === 'campaign').length === 1, mutations('meta'));
  reset(); seedIntegrations(); resetAuto(); schedRule(); Object.assign(P.meta.ads, { 6001: 'PAUSED' }); P.meta.delay = 200; record('meta', '2001', [], ['6001'], 'act_111');
  const race = await Promise.all([activate('meta', '2001'), sleep(30).then(() => exec('meta', '2001'))]);
  check('Launch and Automations at the same moment → one activation; the other is “activation_in_progress”', mutations('meta').filter((c) => c[1] === 'campaign').length === 1 && (race[0].status === 200 && race[1].status === 'skipped' && race[1].reason === 'activation_in_progress'), { launch: race[0].status, auto: race[1] && race[1].reason });

  log('\nQ. Automations — safety controls still win');
  reset(); seedIntegrations(); resetAuto(); schedRule(); Object.assign(P.meta.ads, { 6001: 'PAUSED' }); record('meta', '2001', [], ['6001'], 'act_111');
  H.rows('automation_settings').push({ user_id: U.id, paused_all: true });
  res = await exec('meta', '2001');
  check('pause-all → skipped, nothing changed', res.status === 'skipped' && res.reason === 'paused_all' && !P.calls.length, res);
  H.rows('automation_settings').length = 0; process.env.AUTOMATIONS_KILL_SWITCH = 'true';
  res = await exec('meta', '2001');
  check('kill switch → skipped, nothing changed', res.status === 'skipped' && res.reason === 'kill_switch' && !P.calls.length, res);
  delete process.env.AUTOMATIONS_KILL_SWITCH;
  H.rows('automation_rules')[0].enabled = false;
  res = await exec('meta', '2001');
  check('automation turned off → skipped, nothing changed', res.status === 'skipped' && res.reason === 'automation_paused' && !P.calls.length, res);

  log('\nR. Automations — approval required');
  reset(); seedIntegrations(); resetAuto(); Object.assign(P.meta.ads, { 6001: 'PAUSED' }); record('meta', '2001', [], ['6001'], 'act_111');
  H.rows('automation_rules').push({ id: 'r-appr', user_id: U.id, name: 'Ask to start', kind: 'rule', enabled: true, status: 'active', platform: 'meta', mode: 'approval', action_type: 'resume_campaign', trigger_metric: 'status', trigger_operator: '==', trigger_text: 'paused', scope: { type: 'campaigns', campaign_ids: ['2001'] } });
  H.rows('automation_executions').push({ id: 'ex-ap', user_id: U.id, automation_id: 'r-appr', platform: 'meta', campaign_id: '2001', action: 'resume_campaign', status: 'pending_approval', idempotency_key: 'rule:r-appr:2001' });
  H.rows('automation_approvals').push({ id: 'ap-1', user_id: U.id, automation_id: 'r-appr', execution_id: 'ex-ap', platform: 'meta', campaign_id: '2001', campaign_name: 'Spring', action: 'resume_campaign', params: {}, status: 'pending', expires_at: new Date(Date.now() + 864e5).toISOString(), created_at: new Date().toISOString() });
  check('pending approval: nothing was switched on before approval', !P.calls.length);
  r = await H.call('POST', '/api/automations/approvals/ap-1/approve', TOK, {});
  const ap = H.rows('automation_approvals')[0], apEx = H.rows('automation_executions').find((e) => e.id === 'ex-ap');
  check('approved → the same activation runs (ad, then campaign); approval completed; history completed', r.status === 200 && JSON.stringify(mutations('meta').map((c) => c[1])) === '["ad","campaign"]' && ap.status === 'completed' && apEx.status === 'completed', { http: r.status, body: r.body, ap: ap.status, ex: apEx.status });
  r = await H.call('POST', '/api/automations/approvals/ap-1/approve', TOK, {});
  check('approving twice → refused, nothing switched on again', r.status === 409 && mutations('meta').length === 2, r.status);

  log('\nK. Pause still works and never touches children');
  reset(); seedIntegrations(); P.meta.campaign['2001'] = 'ACTIVE'; Object.assign(P.meta.ads, { 6001: 'ACTIVE' });
  r = await H.call('POST', '/api/meta/campaign/2001/pause', TOK, {});
  check('Meta pause: campaign PAUSED only', r.status === 200 && P.meta.campaign['2001'] === 'PAUSED' && P.meta.ads['6001'] === 'ACTIVE' && mutations('meta').length === 1, r.body);
  r = await H.call('POST', '/api/meta/campaign/2001/resume', null, {});
  check('no session → 401, nothing changed', r.status === 401 && mutations('meta').length === 1);

  check('no request left the process (only the fake provider APIs answered)', !H.net.blocked.length, H.net.blocked.slice(0, 3));
  if (quiet) [console.log, console.warn, console.error] = quiet;
  done();
})().catch((e) => { process.stdout.write('CRASH ' + (e && e.stack || e) + '\n'); process.exit(1); });
