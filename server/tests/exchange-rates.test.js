// services/exchangeRates.js — ECB euro rates for display on the pricing page.
// No network: every ECB request is answered by a fake fetch.
//   node tests/exchange-rates.test.js
const fx = require('../services/exchangeRates');

let pass = 0, fail = 0;
const check = (n, ok, info) => { ok ? pass++ : fail++; console.log((ok ? '  PASS — ' : '  FAIL — ') + n + (ok || info === undefined ? '' : ' :: ' + JSON.stringify(info).slice(0, 300))); };

const XML = (date, usd) => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time='${date}'>
    <Cube currency='USD' rate='${usd}'/><Cube currency='JPY' rate='163.42'/><Cube currency='GBP' rate='0.8412'/>
    <Cube currency='CHF' rate='0.9381'/><Cube currency='INR' rate='90.115'/><Cube currency='PLN' rate='4.2655'/>
  </Cube></Cube></gesmes:Envelope>`;

function fakeFetch(responses) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push(url);
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (r instanceof Error) throw r;
    return { ok: r.status === 200, status: r.status, text: async () => r.body };
  };
  f.calls = calls;
  return f;
}
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

(async () => {
  console.log('\nA. Parsing the ECB file');
  const p = fx.parseEcb(XML('2026-11-04', '1.0812'));
  check('date and rates read; EUR added as 1', p.date === '2026-11-04' && p.rates.USD === 1.0812 && p.rates.JPY === 163.42 && p.rates.EUR === 1, p);
  let e = null; try { fx.parseEcb('<html>maintenance</html>'); } catch (x) { e = x.message; }
  check('an unexpected answer (e.g. a maintenance page) is rejected, never cached as rates', /unexpected ECB response/.test(e || ''), e);

  console.log('\nB. Caching: the ECB is asked at most once per 12 hours');
  let f = fakeFetch([{ status: 200, body: XML('2026-11-04', '1.0812') }]);
  fx._reset({ fetch: f });
  const t0 = Date.now();
  let r = await fx.getRates(t0);
  check('first request fetches from the ECB', f.calls.length === 1 && f.calls[0] === fx.ECB_URL && r.rates.USD === 1.0812 && r.stale === false, r);
  for (let i = 0; i < 25; i++) await fx.getRates(t0 + i * 60 * 1000);
  check('25 more requests within the hour: no further ECB request', f.calls.length === 1, f.calls.length);
  await fx.getRates(t0 + fx.TTL_MS - 1000);
  check('still cached just before 12 hours', f.calls.length === 1);

  f = fakeFetch([{ status: 200, body: XML('2026-11-04', '1.0812') }, { status: 200, body: XML('2026-11-05', '1.0900') }]);
  fx._reset({ fetch: f });
  await fx.getRates(t0);
  r = await fx.getRates(t0 + fx.TTL_MS + 1000);
  check('after 12 hours the rates are refreshed', f.calls.length === 2 && r.rates.USD === 1.09 && r.date === '2026-11-05', r);

  f = fakeFetch([{ status: 200, body: XML('2026-11-04', '1.0812') }]);
  fx._reset({ fetch: f });
  const many = await Promise.all(Array.from({ length: 10 }, () => fx.getRates(t0)));
  check('10 simultaneous first requests share one ECB request', f.calls.length === 1 && many.every((x) => x.rates.USD === 1.0812), f.calls.length);

  console.log('\nC. The ECB is unavailable');
  f = fakeFetch([{ status: 200, body: XML('2026-11-04', '1.0812') }, new Error('network down')]);
  fx._reset({ fetch: f });
  await fx.getRates(t0);
  const realNow = Date.now;
  Date.now = () => t0 + fx.TTL_MS + 5000;
  r = await fx.getRates(t0 + fx.TTL_MS + 5000);
  check('refresh fails → the last good rates keep being served, marked stale', r && r.rates.USD === 1.0812 && r.stale === true, r);
  await fx.getRates(t0 + fx.TTL_MS + 6000);
  check('…and it does not hammer the ECB: no retry within 10 minutes', f.calls.length === 2, f.calls.length);
  Date.now = realNow;

  f = fakeFetch([{ status: 503, body: 'down' }]);
  fx._reset({ fetch: f });
  r = await fx.getRates();
  check('no rates ever fetched and the ECB fails → null (the page stays in EUR)', r === null);
  const res = fakeRes();
  await fx.handler({}, res);
  check('endpoint answers 503 RATES_UNAVAILABLE, not cached', res.statusCode === 503 && res.body.code === 'RATES_UNAVAILABLE' && res.headers['Cache-Control'] === 'no-store', res);

  console.log('\nD. The endpoint');
  f = fakeFetch([{ status: 200, body: XML('2026-11-04', '1.0812') }]);
  fx._reset({ fetch: f });
  const ok = fakeRes();
  await fx.handler({}, ok);
  check('200 with base EUR, the date, the rates and a display-only note; cacheable for an hour', ok.statusCode === 200 && ok.body.base === 'EUR' && ok.body.date === '2026-11-04' && ok.body.rates.GBP === 0.8412 && /processed in EUR/.test(ok.body.note) && ok.headers['Cache-Control'] === 'public, max-age=3600', ok);

  fx._reset();
  console.log(`\n${pass + fail} checks run, ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
