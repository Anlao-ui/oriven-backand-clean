// ── Weekly report: reporting periods ─────────────────────────────────
//
// The report covers the previous completed Monday–Sunday week in the
// user's own timezone (profiles.timezone, synced from the browser). When a
// user has no valid timezone, DEFAULT_TIMEZONE is used (documented in the
// email footer as the timezone the week was computed in).
//
// A week's report becomes due on Monday at SEND_HOUR local time and stays
// due until the end of Wednesday (local). The job runs every 30 minutes, so a
// restart or sleeping instance still delivers the report on its next run;
// after Wednesday a missed week is not sent late.
//
// All dates are plain 'YYYY-MM-DD' strings; arithmetic happens in UTC on
// those calendar dates, so daylight-saving changes can't shift a day.

const DEFAULT_TIMEZONE = 'Europe/Amsterdam';
const SEND_HOUR = 7;          // Monday 07:00 local
const LAST_DUE_WEEKDAY = 3;   // through Wednesday (1 = Monday)

function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch (_) { return false; }
}

function resolveTimeZone(tz) { return validTimeZone(tz) ? tz : DEFAULT_TIMEZONE; }

// Local calendar date, ISO weekday (1 = Monday … 7 = Sunday) and hour of an
// instant in a timezone.
function localParts(now, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(now));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')];
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday, hour: Number(get('hour')) % 24 };
}

function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The last completed Monday–Sunday week (and the one before it, for
// week-over-week comparison) as seen from `now` in `tz`.
function lastCompletedWeek(now, tz) {
  const zone = resolveTimeZone(tz);
  const { date, weekday } = localParts(now, zone);
  const thisMonday = addDays(date, -(weekday - 1));
  const start = addDays(thisMonday, -7);
  return {
    start, end: addDays(start, 6),
    previous: { start: addDays(start, -7), end: addDays(start, -1) },
    timeZone: zone, defaultTimeZone: zone !== tz,
  };
}

// Is the last completed week's report due at `now` in `tz`?
function isDue(now, tz) {
  const { weekday, hour } = localParts(now, resolveTimeZone(tz));
  if (weekday === 1) return hour >= SEND_HOUR;
  return weekday > 1 && weekday <= LAST_DUE_WEEKDAY;
}

module.exports = { DEFAULT_TIMEZONE, SEND_HOUR, validTimeZone, resolveTimeZone, localParts, addDays, lastCompletedWeek, isDue };
