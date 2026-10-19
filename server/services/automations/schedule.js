// ════════════════════════════════════════════════════════════════
// Automations — schedule maths (pure, no dependencies).
//
// A scheduled automation stores what the user chose in their own wall-clock
// time plus an IANA time zone; each occurrence is materialised as a job with
// an exact UTC run_at. Daylight saving time:
//   • a wall time that doesn't exist (spring forward, e.g. 02:30 on the
//     last Sunday of March in Europe/Amsterdam) runs at the first valid
//     minute after the gap (03:30) — never skipped, never an hour early;
//   • a wall time that happens twice (fall back) runs once, at the first
//     occurrence;
//   • weekly items keep their wall time across the change (09:00 stays
//     09:00 local), so the UTC time shifts by an hour — on purpose.
// ════════════════════════════════════════════════════════════════
'use strict';

const ACTIONS = ['activate', 'pause', 'resume', 'stop'];

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}

const _fmtCache = new Map();
function _fmt(tz) {
  if (!_fmtCache.has(tz)) _fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }));
  return _fmtCache.get(tz);
}
const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
// Wall-clock parts of a UTC instant in tz. weekday: ISO 1 (Mon) … 7 (Sun).
function zonedParts(ms, tz) {
  const o = {};
  _fmt(tz).formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute, ss: +o.second, weekday: WD[o.weekday] };
}
function _offset(ms, tz) { const p = zonedParts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000; }

// Wall time in tz → UTC ms. Returns { utc, adjusted: null | 'gap' | 'ambiguous' }.
function zonedToUtc(w, tz) {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm || 0, 0);
  const oA = _offset(guess - 12 * 3600e3, tz), oB = _offset(guess + 12 * 3600e3, tz);
  const cands = Array.from(new Set([guess - oA, guess - oB])).sort((a, b) => a - b);
  const matches = cands.filter((t) => { const p = zonedParts(t, tz); return p.y === w.y && p.m === w.m && p.d === w.d && p.hh === w.hh && p.mm === (w.mm || 0); });
  if (matches.length === 2) return { utc: matches[0], adjusted: 'ambiguous' };
  if (matches.length === 1) return { utc: matches[0], adjusted: null };
  // In a gap: interpreting with the pre-transition offset lands just after it.
  return { utc: guess - oA, adjusted: 'gap' };
}

function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const w = { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5] };
  if (w.m < 1 || w.m > 12 || w.d < 1 || w.d > 31 || w.hh > 23 || w.mm > 59) return null;
  const chk = new Date(Date.UTC(w.y, w.m - 1, w.d));
  if (chk.getUTCMonth() !== w.m - 1 || chk.getUTCDate() !== w.d) return null; // e.g. 2026-02-30
  return w;
}
const pad = (n) => String(n).padStart(2, '0');
function localKey(w) { return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.hh)}:${pad(w.mm)}`; }
function parseTime(s) { const m = /^(\d{2}):(\d{2})$/.exec(String(s || '')); if (!m || +m[1] > 23 || +m[2] > 59) return null; return { hh: +m[1], mm: +m[2] }; }

// Validates a schedule as stored on an automation:
// { timezone, items: [{ key, action, type:'once', at:'YYYY-MM-DDTHH:MM' }
//                     | { key, action, type:'weekly', days:[1..7], time:'HH:MM' }],
//   ends_at?: 'YYYY-MM-DDTHH:MM' }
function validate(sched, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  if (!sched || typeof sched !== 'object') return { ok: false, error: 'schedule is required' };
  if (!isValidTimeZone(sched.timezone)) return { ok: false, error: 'Choose a valid time zone.', code: 'timezone' };
  const items = Array.isArray(sched.items) ? sched.items : [];
  if (!items.length) return { ok: false, error: 'Add at least one scheduled action.', code: 'no_items' };
  if (items.length > (opts.maxItems || 14)) return { ok: false, error: 'Too many scheduled actions in one automation.', code: 'too_many_items' };
  const out = [];
  const keys = new Set();
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const key = String(it.key || ('i' + i)).replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || ('i' + i);
    if (keys.has(key)) return { ok: false, error: 'Duplicate schedule item.', code: 'duplicate_item' };
    keys.add(key);
    if (!ACTIONS.includes(it.action)) return { ok: false, error: 'Unknown scheduled action.', code: 'action' };
    if (it.type === 'once') {
      const w = parseLocal(it.at);
      if (!w) return { ok: false, error: 'Enter a valid date and time.', code: 'at' };
      const { utc } = zonedToUtc(w, sched.timezone);
      if (utc <= now) return { ok: false, error: 'Choose a date and time in the future.', code: 'past' };
      out.push({ key, action: it.action, type: 'once', at: localKey(w) });
    } else if (it.type === 'weekly') {
      if (it.action === 'stop') return { ok: false, error: '"Stop" is a one-time action.', code: 'stop_weekly' };
      const days = Array.from(new Set((it.days || []).map(Number))).filter((d) => d >= 1 && d <= 7).sort();
      if (!days.length) return { ok: false, error: 'Choose at least one day.', code: 'days' };
      const t = parseTime(it.time);
      if (!t) return { ok: false, error: 'Enter a valid time.', code: 'time' };
      out.push({ key, action: it.action, type: 'weekly', days, time: `${pad(t.hh)}:${pad(t.mm)}` });
    } else return { ok: false, error: 'Choose one-time or weekly.', code: 'type' };
  }
  let endsAt = null;
  if (sched.ends_at) {
    const w = parseLocal(sched.ends_at);
    if (!w) return { ok: false, error: 'Enter a valid end date.', code: 'ends_at' };
    if (zonedToUtc(w, sched.timezone).utc <= now) return { ok: false, error: 'The end date must be in the future.', code: 'ends_past' };
    endsAt = localKey(w);
  }
  if (!endsAt && out.some((i) => i.type === 'weekly') && opts.requireEnd) return { ok: false, error: 'Recurring schedules need an end date.', code: 'ends_required' };
  // A weekly activate and pause at the very same day+time would fight.
  const slots = new Set();
  for (const it of out.filter((x) => x.type === 'weekly')) for (const d of it.days) {
    const k = d + '@' + it.time;
    if (slots.has(k)) return { ok: false, error: 'Two actions are scheduled for the same day and time.', code: 'same_slot' };
    slots.add(k);
  }
  return { ok: true, schedule: { timezone: sched.timezone, items: out, ends_at: endsAt } };
}

// Next run of one item strictly after afterMs. Returns { runAt, localKey,
// adjusted } or null (one-time item already past, or beyond ends_at).
function nextOccurrence(item, sched, afterMs) {
  const tz = sched.timezone;
  const endUtc = sched.ends_at ? zonedToUtc(parseLocal(sched.ends_at), tz).utc : null;
  let res = null;
  if (item.type === 'once') {
    const w = parseLocal(item.at);
    const z = zonedToUtc(w, tz);
    if (z.utc > afterMs) res = { runAt: z.utc, localKey: localKey(w), adjusted: z.adjusted };
  } else if (item.type === 'weekly') {
    const t = parseTime(item.time);
    const start = zonedParts(afterMs, tz);
    for (let i = 0; i < 9 && !res; i++) {
      const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
      const w = { y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), hh: t.hh, mm: t.mm };
      const isoDow = ((day.getUTCDay() + 6) % 7) + 1;
      if (!item.days.includes(isoDow)) continue;
      const z = zonedToUtc(w, tz);
      if (z.utc > afterMs) res = { runAt: z.utc, localKey: localKey(w), adjusted: z.adjusted };
    }
  }
  if (res && endUtc != null && res.runAt > endUtc) return null;
  return res;
}

module.exports = { ACTIONS, isValidTimeZone, zonedParts, zonedToUtc, parseLocal, parseTime, localKey, validate, nextOccurrence };
