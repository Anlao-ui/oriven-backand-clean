// services/userStorage.js — account deletion removes the user's files.
// In-memory fake of the Supabase Storage client; no network, no database.
// Run: node tests/user-storage.test.js
const { removeUserFiles, prefixesFor } = require('../services/userStorage');

let passed = 0, failed = 0;
function check(name, ok, info) { if (ok) { passed++; console.log('  PASS', name); } else { failed++; console.log('  FAIL', name, info === undefined ? '' : JSON.stringify(info)); } }

const A = '11111111-2222-4333-8444-555555555555';
const B = '99999999-8888-4777-8666-555555555555';

function fakeStorage(paths, opts) {
  opts = opts || {};
  const files = new Set(paths);
  const calls = { list: [], remove: [] };
  const bucket = {
    async list(prefix, o) {
      calls.list.push([prefix, o]);
      if (opts.listError) return { data: null, error: { message: 'boom', statusCode: 500 } };
      const kids = new Map();
      for (const f of files) {
        if (!f.startsWith(prefix + '/')) continue;
        const rest = f.slice(prefix.length + 1);
        const name = rest.split('/')[0];
        kids.set(name, rest.includes('/') ? { name, id: null } : { name, id: 'id-' + name });
      }
      const all = [...kids.values()].sort((x, y) => x.name.localeCompare(y.name));
      return { data: all.slice(o.offset, o.offset + o.limit), error: null };
    },
    async remove(list) {
      calls.remove.push(list.slice());
      if (opts.removeError) return { data: null, error: { message: 'denied', statusCode: 403 } };
      list.forEach((p) => files.delete(p));
      return { data: list.map((name) => ({ name })), error: null };
    },
  };
  return { files, calls, client: { from: (b) => { calls.bucket = b; return bucket; } } };
}

(async () => {
  console.log('\n1. Removes exactly the user\'s two prefixes');
  {
    const s = fakeStorage([
      A + '/a.png', A + '/b.jpg', 'generated/' + A + '/1.png', 'generated/' + A + '/video-x.mp4',
      B + '/keep.png', 'generated/' + B + '/keep.png', 'other/' + A + '.png',
    ]);
    const n = await removeUserFiles(s.client, 'manual-campaign-creatives', A);
    check('4 files of user A removed', n === 4, n);
    check('user B and unrelated paths untouched', [...s.files].sort().join() === ['generated/' + B + '/keep.png', 'other/' + A + '.png', B + '/keep.png'].sort().join(), [...s.files]);
    check('uses the given bucket', s.calls.bucket === 'manual-campaign-creatives');
  }

  console.log('\n2. Nested folders and paging');
  {
    const many = [];
    for (let i = 0; i < 2350; i++) many.push(A + '/f' + String(i).padStart(5, '0') + '.png');
    many.push(A + '/sub/deep.png');
    const s = fakeStorage(many);
    const n = await removeUserFiles(s.client, 'bkt', A);
    check('all 2351 files removed (3 list pages + subfolder)', n === 2351 && s.files.size === 0, { n, left: s.files.size });
    check('removed in chunks of at most 100', s.calls.remove.every((c) => c.length <= 100));
  }

  console.log('\n3. Nothing stored');
  {
    const s = fakeStorage([B + '/x.png']);
    check('no files → 0, no remove call', (await removeUserFiles(s.client, 'bkt', A)) === 0 && s.calls.remove.length === 0);
    check('no Storage client → 0', (await removeUserFiles(null, 'bkt', A)) === 0);
  }

  console.log('\n4. Errors stop the deletion');
  {
    let e = null;
    try { await removeUserFiles(fakeStorage([A + '/a.png'], { listError: true }).client, 'bkt', A); } catch (err) { e = err; }
    check('list error throws', !!e && /list failed/.test(e.message), e && e.message);
    e = null;
    try { await removeUserFiles(fakeStorage([A + '/a.png'], { removeError: true }).client, 'bkt', A); } catch (err) { e = err; }
    check('remove error throws', !!e && /remove failed/.test(e.message), e && e.message);
  }

  console.log('\n5. Never widens the prefix');
  for (const bad of ['', ' ', '..', A + '/..', 'generated', null, undefined, '*']) {
    let e = null;
    try { await removeUserFiles(fakeStorage([A + '/a.png']).client, 'bkt', bad); } catch (err) { e = err; }
    check('rejects user id ' + JSON.stringify(bad), !!e && /invalid user id/.test(e.message));
  }
  check('prefixes are <id> and generated/<id>', JSON.stringify(prefixesFor(A)) === JSON.stringify([A, 'generated/' + A]));

  console.log('\n6. Wired into account deletion (services/accountDeletion.js)');
  {
    const fs = require('fs'), path = require('path');
    const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'accountDeletion.js'), 'utf8');
    const fn = svc.slice(svc.indexOf('async function deleteAccount('), svc.indexOf('async function findAuthUserByEmail('));
    const iStripe = fn.indexOf('cancelSubscription('), iFiles = fn.indexOf('removeUserFiles('), iRpc = fn.indexOf("rpc('delete_account_data'"), iAuth = fn.indexOf('deleteAuthUser(');
    check('order: cancel Stripe → remove files → delete data → sign-in account', iStripe > 0 && iFiles > iStripe && iRpc > iFiles && iAuth > iRpc, { iStripe, iFiles, iRpc, iAuth });
    check('storage failure aborts with STORAGE_DELETE_FAILED', /fail\('STORAGE_DELETE_FAILED'/.test(fn));
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('server.js uses the same bucket the uploads use', /storage: supabaseAdmin\.storage, bucket: MANUAL_CREATIVE_BUCKET/.test(src) && /accountDeletion'\)\.deleteAccount\(_deletionDeps\(\), userId\)/.test(src));
  }

  console.log(`\n${passed + failed} checks run: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
