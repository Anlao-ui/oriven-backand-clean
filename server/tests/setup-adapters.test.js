// ════════════════════════════════════════════════════════════════
// Platform Setup Adapters (Meta/Google/Pinterest/TikTok) — mock-API tests
//
// These are the exact "MOCK API TESTS" the spec calls for in the
// situation where real destructive operations cannot safely be
// tested: no real, elevated-permission OAuth app credentials exist in
// this environment to create real ad-account resources (Pixels,
// conversion actions, tags) against a live Meta/Google/Pinterest
// account, so every adapter function is exercised here against a
// hand-written fake `apiClient`/`gadsClient` that simulates real
// platform responses (success, already-exists, malformed response) —
// proving the adapter's OWN logic (idempotency, verify-after-mutate,
// never-duplicate) is correct, independent of live platform access.
//
// RUN: node tests/setup-adapters.test.js   (from oriven-backand-clean/server)
// ════════════════════════════════════════════════════════════════

const assert = require('assert/strict');
const metaAdapter = require('../services/adapters/metaSetupAdapter');
const googleAdapter = require('../services/adapters/googleSetupAdapter');
const pinterestAdapter = require('../services/adapters/pinterestSetupAdapter');
const tiktokAdapter = require('../services/adapters/tiktokSetupAdapter');

const results = [];
function record(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log('  PASS —', name); },
    (err) => { results.push({ name, ok: false, err }); console.log('  FAIL —', name, '\n        ', err.message); }
  );
}

async function main() {
  // ── META ──────────────────────────────────────────────────────
  await record('1. Meta ensurePixel: reuses an existing pixel, never creates a duplicate (idempotency)', async () => {
    let postCalled = false;
    const client = {
      get: async (path) => {
        if (path.endsWith('/adspixels')) return { data: [{ id: 'px_1', name: 'Existing Pixel' }] };
        return {};
      },
      post: async () => { postCalled = true; return {}; },
    };
    const r = await metaAdapter.ensurePixel(client, 'act_1', 'My Pixel');
    assert.equal(r.created, false);
    assert.equal(r.pixel.id, 'px_1');
    assert.equal(postCalled, false, 'must not call POST when a pixel already exists');
  });

  await record('2. Meta ensurePixel: creates + verifies when none exists', async () => {
    let getCallCount = 0;
    const client = {
      get: async (path) => {
        getCallCount++;
        if (path.endsWith('/adspixels')) return { data: [] };
        if (path === '/px_new') return { id: 'px_new', name: 'ORIVEN Pixel' };
        return {};
      },
      post: async () => ({ id: 'px_new' }),
    };
    const r = await metaAdapter.ensurePixel(client, 'act_1', 'ORIVEN Pixel');
    assert.equal(r.created, true);
    assert.equal(r.pixel.id, 'px_new');
    assert.ok(getCallCount >= 2, 'must verify the created pixel with a follow-up GET, not trust the POST alone');
  });

  await record('3. Meta ensurePixel: throws (never fakes success) if create response has no id', async () => {
    const client = { get: async () => ({ data: [] }), post: async () => ({}) };
    await assert.rejects(() => metaAdapter.ensurePixel(client, 'act_1', 'X'), /did not return a pixel id/);
  });

  await record('4. Meta checkPixelHealth: distinguishes exists / installed / receiving events as separate signals', async () => {
    const client = { get: async () => ({ id: 'px_1', last_fired_time: '2026-08-01T00:00:00Z', has_1p_pixel_event: false }) };
    const h = await metaAdapter.checkPixelHealth(client, 'px_1');
    assert.equal(h.exists, true);
    assert.equal(h.installed, true); // has fired at least once
    assert.equal(h.receivingEvents, false); // but not currently receiving 1p events
  });

  await record('5. Meta checkPixelHealth: pixel that never fired reports installed:false, not a fabricated true', async () => {
    const client = { get: async () => ({ id: 'px_1', last_fired_time: null, has_1p_pixel_event: false }) };
    const h = await metaAdapter.checkPixelHealth(client, 'px_1');
    assert.equal(h.installed, false);
  });

  await record('6. Meta checkAdAccountStatus: correctly reads account_status/disable_reason', async () => {
    const client = { get: async () => ({ account_status: 2, disable_reason: 'ADS_INTEGRITY_POLICY' }) };
    const s = await metaAdapter.checkAdAccountStatus(client, 'act_1');
    assert.equal(s.active, false);
    assert.equal(s.disableReason, 'ADS_INTEGRITY_POLICY');
  });

  // ── GOOGLE ────────────────────────────────────────────────────
  await record('7. Google ensureConversionAction: reuses existing action by name, never duplicates', async () => {
    let mutateCalled = false;
    const client = {
      query: async () => ([{ conversionAction: { id: '1', name: 'Purchase', status: 'ENABLED' } }]),
      mutate: async () => { mutateCalled = true; return {}; },
    };
    const r = await googleAdapter.ensureConversionAction(client, { name: 'Purchase' });
    assert.equal(r.created, false);
    assert.equal(mutateCalled, false, 'must not mutate when a conversion action with this name already exists');
  });

  await record('8. Google ensureConversionAction: creates + verifies via a follow-up query when none exists', async () => {
    let queryCallCount = 0;
    const client = {
      query: async () => {
        queryCallCount++;
        return queryCallCount === 1 ? [] : [{ conversionAction: { id: '2', name: 'Lead', status: 'ENABLED' } }];
      },
      mutate: async () => ({ results: [{ resourceName: 'customers/1/conversionActions/2' }] }),
    };
    const r = await googleAdapter.ensureConversionAction(client, { name: 'Lead', category: 'SUBMIT_LEAD_FORM' });
    assert.equal(r.created, true);
    assert.equal(r.conversionAction.id, '2');
    assert.ok(queryCallCount >= 2, 'must verify via a real follow-up query, not trust the mutate response alone');
  });

  await record('9. Google ensureConversionAction: throws (never fakes success) if mutate returns no resourceName', async () => {
    const client = { query: async () => [], mutate: async () => ({ results: [{}] }) };
    await assert.rejects(() => googleAdapter.ensureConversionAction(client, { name: 'X' }), /did not return a conversion action resource name/);
  });

  await record('10. Google checkConversionActionStatus: reports exists:false honestly when nothing found', async () => {
    const client = { query: async () => [] };
    const s = await googleAdapter.checkConversionActionStatus(client, 'Nonexistent');
    assert.equal(s.exists, false);
    assert.equal(s.enabled, false);
  });

  // ── PINTEREST ─────────────────────────────────────────────────
  await record('11. Pinterest ensureTag: reuses existing tag, never duplicates', async () => {
    let postCalled = false;
    const client = {
      get: async () => ({ items: [{ id: 'tag_1', status: 'ACTIVE' }] }),
      post: async () => { postCalled = true; return {}; },
    };
    const r = await pinterestAdapter.ensureTag(client, 'ad_1', 'ORIVEN Tag');
    assert.equal(r.created, false);
    assert.equal(postCalled, false);
  });

  await record('12. Pinterest ensureTag: creates + verifies when none exists, defaults enhanced match OFF', async () => {
    let postedBody = null;
    let getCallCount = 0;
    const client = {
      get: async () => { getCallCount++; return getCallCount === 1 ? { items: [] } : { items: [{ id: 'tag_new' }] }; },
      post: async (path, body) => { postedBody = body; return { id: 'tag_new' }; },
    };
    const r = await pinterestAdapter.ensureTag(client, 'ad_1', 'ORIVEN Tag');
    assert.equal(r.created, true);
    assert.equal(postedBody.enhanced_match_status, 'DISABLED');
    assert.ok(getCallCount >= 2, 'must verify the created tag with a follow-up GET');
  });

  await record('13. Pinterest checkTagHealth: no tag -> exists:false, not fabricated', async () => {
    const client = { get: async () => ({ items: [] }) };
    const h = await pinterestAdapter.checkTagHealth(client, 'ad_1');
    assert.equal(h.exists, false);
    assert.equal(h.receivingEvents, false);
  });

  // ── TIKTOK ────────────────────────────────────────────────────
  await record('14. TikTok sendEvent: requires a real pixelCode, refuses to guess one', async () => {
    const client = { post: async () => ({ code: 0 }) };
    await assert.rejects(() => tiktokAdapter.sendEvent(client, { event: 'Purchase' }), /pixel code is required/);
  });

  await record('15. TikTok sendEvent: reports sent:false honestly on a non-zero response code (never fakes success)', async () => {
    const client = { post: async () => ({ code: 40002, message: 'Invalid pixel_code' }) };
    const r = await tiktokAdapter.sendEvent(client, { pixelCode: 'bad', event: 'Purchase' });
    assert.equal(r.sent, false);
  });

  await record('16. TikTok sendEvent: reports sent:true on a genuine success response', async () => {
    const client = { post: async () => ({ code: 0, message: 'OK' }) };
    const r = await tiktokAdapter.sendEvent(client, { pixelCode: 'good_pixel', event: 'Purchase', eventId: 'evt_1' });
    assert.equal(r.sent, true);
  });

  // ── META — Completion Pass additions ─────────────────────────────
  await record('17. Meta findExistingBusinesses: maps real /me/businesses response fields honestly', async () => {
    const client = { get: async () => ({ data: [{ id: 'b1', name: 'Acme', verification_status: 'verified' }] }) };
    const list = await metaAdapter.findExistingBusinesses(client);
    assert.equal(list.length, 1);
    assert.equal(list[0].verificationStatus, 'verified');
  });

  await record('18. Meta sendServerEvent: reports sent:true only when events_received > 0, never from HTTP 200 alone', async () => {
    const client = { post: async () => ({ events_received: 0, messages: [{ description: 'Invalid event' }] }) };
    const r = await metaAdapter.sendServerEvent(client, 'px_1', [{ eventName: 'Purchase' }]);
    assert.equal(r.sent, false);
  });

  await record('19. Meta sendServerEvent: reports sent:true on a genuine events_received > 0 response', async () => {
    const client = { post: async () => ({ events_received: 1, fbtrace_id: 'abc123', messages: [] }) };
    const r = await metaAdapter.sendServerEvent(client, 'px_1', [{ eventName: 'Purchase' }]);
    assert.equal(r.sent, true);
    assert.equal(r.fbtraceId, 'abc123');
  });

  // ── GOOGLE — Completion Pass additions ───────────────────────────
  await record('20. Google fetchTagSnippets: returns exists:false honestly when no conversion action is found', async () => {
    const client = { query: async () => [] };
    const r = await googleAdapter.fetchTagSnippets(client, 'Nonexistent');
    assert.equal(r.exists, false);
    assert.deepEqual(r.snippets, []);
  });

  await record('21. Google fetchTagSnippets: maps real tag_snippets fields (camelCase API response) honestly', async () => {
    const client = { query: async () => ([{ conversionAction: { id: '1', tagSnippets: [{ type: 'WEBSITE', globalSiteTag: '<script>gtag</script>', eventSnippet: '<script>event</script>' }] } }]) };
    const r = await googleAdapter.fetchTagSnippets(client, 'Purchase');
    assert.equal(r.exists, true);
    assert.equal(r.snippets[0].globalSiteTag, '<script>gtag</script>');
  });

  await record('22. Google checkCustomerStatus: reports active:false and isManager honestly from real fields', async () => {
    const client = { query: async () => ([{ customer: { id: '1', status: 'SUSPENDED', manager: false } }]) };
    const s = await googleAdapter.checkCustomerStatus(client);
    assert.equal(s.exists, true);
    assert.equal(s.active, false);
    assert.equal(s.status, 'SUSPENDED');
  });

  // ── PINTEREST — Completion Pass additions ────────────────────────
  await record('23. Pinterest sendConversionEvents: reports sent:true only when num_events_processed > 0', async () => {
    const client = { post: async () => ({ num_events_received: 1, num_events_processed: 0, events: [{ error_message: 'Invalid event_name' }] }) };
    const r = await pinterestAdapter.sendConversionEvents(client, 'ad_1', [{ eventName: 'bad_event' }]);
    assert.equal(r.sent, false);
    assert.equal(r.received, 1);
    assert.equal(r.processed, 0);
  });

  await record('24. Pinterest sendConversionEvents: reports sent:true on a genuine processed > 0 response', async () => {
    const client = { post: async () => ({ num_events_received: 1, num_events_processed: 1, events: [] }) };
    const r = await pinterestAdapter.sendConversionEvents(client, 'ad_1', [{ eventName: 'page_visit', actionSource: 'web' }]);
    assert.equal(r.sent, true);
  });

  await record('25. Pinterest sendConversionEvents: requires at least one event', async () => {
    const client = { post: async () => ({}) };
    await assert.rejects(() => pinterestAdapter.sendConversionEvents(client, 'ad_1', []), /At least one event is required/);
  });

  await record('26. Pinterest ensureAdAccount: reuses an existing account, never creates a duplicate (idempotency)', async () => {
    let postCalled = false;
    const listAccounts = async () => ({ accounts: [{ id: 'acc_1', name: 'Existing' }] });
    const client = { post: async () => { postCalled = true; return {}; } };
    const r = await pinterestAdapter.ensureAdAccount(client, listAccounts, 'user_1', { name: 'New', country: 'US' });
    assert.equal(r.created, false);
    assert.equal(postCalled, false);
  });

  await record('27. Pinterest ensureAdAccount: creates + verifies via a follow-up discovery call when none exists', async () => {
    let callCount = 0;
    const listAccounts = async () => { callCount++; return callCount === 1 ? { accounts: [] } : { accounts: [{ id: 'acc_new', name: 'New' }] }; };
    const client = { post: async () => ({ id: 'acc_new' }) };
    const r = await pinterestAdapter.ensureAdAccount(client, listAccounts, 'user_1', { name: 'New', country: 'US' });
    assert.equal(r.created, true);
    assert.ok(callCount >= 2, 'must verify via a real follow-up discovery call, not trust the create response alone');
  });

  await record('28. Pinterest ensureAdAccount: requires a real ownerUserId, refuses to guess one', async () => {
    const client = { post: async () => ({}) };
    await assert.rejects(() => pinterestAdapter.ensureAdAccount(client, async () => ({ accounts: [] }), null, { name: 'X', country: 'US' }), /Pinterest user account could not be identified/);
  });

  // ── TIKTOK — Completion Pass additions ───────────────────────────
  await record('29. TikTok findBusinessCenters: maps real /bc/get/ response fields honestly', async () => {
    const client = { get: async () => ({ list: [{ bc_id: 'bc_1', name: 'My Business Center', role: 'ADMIN' }] }) };
    const list = await tiktokAdapter.findBusinessCenters(client);
    assert.equal(list.length, 1);
    assert.equal(list[0].bcId, 'bc_1');
  });

  await record('30. TikTok ensureAdvertiserAccount: reuses an existing advertiser account under this BC, never creates a duplicate', async () => {
    let postCalled = false;
    const listAdvertisers = async () => ([{ account_id: 'adv_1', account_name: 'Existing' }]);
    const client = { post: async () => { postCalled = true; return {}; } };
    const r = await tiktokAdapter.ensureAdvertiserAccount(client, listAdvertisers, 'bc_1', { name: 'New Account' });
    assert.equal(r.created, false);
    assert.equal(postCalled, false);
  });

  await record('31. TikTok ensureAdvertiserAccount: creates + verifies ENTIRELY via a real follow-up discovery call (response field names are unconfirmed by design)', async () => {
    let callCount = 0;
    const listAdvertisers = async () => { callCount++; return callCount === 1 ? [] : [{ account_id: 'adv_new', account_name: 'New Account' }]; };
    const client = { post: async () => ({ /* deliberately no confirmed field to trust */ }) };
    const r = await tiktokAdapter.ensureAdvertiserAccount(client, listAdvertisers, 'bc_1', { name: 'New Account' });
    assert.equal(r.created, true);
    assert.ok(callCount >= 2);
  });

  await record('32. TikTok ensureAdvertiserAccount: honestly reports a pending/unverified state (never fakes success) if the follow-up discovery still finds nothing', async () => {
    const listAdvertisers = async () => [];
    const client = { post: async () => ({}) };
    await assert.rejects(() => tiktokAdapter.ensureAdvertiserAccount(client, listAdvertisers, 'bc_1', { name: 'New Account' }), /could not be verified yet/);
  });

  await record('33. TikTok ensureAdvertiserAccount: requires a Business Center id, refuses to guess one', async () => {
    const client = { post: async () => ({}) };
    await assert.rejects(() => tiktokAdapter.ensureAdvertiserAccount(client, async () => [], null, { name: 'X' }), /Business Center is required/);
  });

  await record('34. TikTok checkPixelLinkage: reports linked:false honestly when the pixel has no linked accounts', async () => {
    const client = { get: async () => ({ list: [] }) };
    const l = await tiktokAdapter.checkPixelLinkage(client, 'bc_1', 'pixel_abc');
    assert.equal(l.linked, false);
  });

  await record('35. TikTok ensurePixelLinked: skips linking (alreadyLinked:true) if the pixel is already linked to this advertiser', async () => {
    let postCalled = false;
    const client = {
      get: async () => ({ list: [{ advertiser_id: 'adv_1' }] }),
      post: async () => { postCalled = true; return {}; },
    };
    const r = await tiktokAdapter.ensurePixelLinked(client, 'bc_1', 'pixel_abc', 'adv_1');
    assert.equal(r.alreadyLinked, true);
    assert.equal(postCalled, false);
  });

  await record('36. TikTok ensurePixelLinked: links + verifies via a real follow-up linkage check when not yet linked', async () => {
    let getCallCount = 0;
    const client = {
      get: async () => { getCallCount++; return getCallCount === 1 ? { list: [] } : { list: [{ advertiser_id: 'adv_1' }] }; },
      post: async () => ({}),
    };
    const r = await tiktokAdapter.ensurePixelLinked(client, 'bc_1', 'pixel_abc', 'adv_1');
    assert.equal(r.linked, true);
    assert.ok(getCallCount >= 2, 'must verify via a real follow-up GET, not trust the POST alone');
  });

  await record('37. TikTok ensurePixelLinked: throws (never fakes success) if the follow-up check still shows no linkage', async () => {
    const client = { get: async () => ({ list: [] }), post: async () => ({}) };
    await assert.rejects(() => tiktokAdapter.ensurePixelLinked(client, 'bc_1', 'pixel_abc', 'adv_1'), /did not confirm the pixel link/);
  });

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length} checks run, ${results.length - failed.length} passed, ${failed.length} failed.`);
  if (failed.length) process.exit(1);
}

main().catch(e => { console.error('CRASH:', e); process.exit(1); });
