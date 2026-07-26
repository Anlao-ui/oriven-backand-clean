// ════════════════════════════════════════════════════════════════
// Intelligence Event Log — shared write helper.
//
// Used by server.js (the continuous-monitoring cron job, and anywhere
// else that detects something worth surfacing) AND services/toolRouter.js
// (campaign action logging) — one write path into `intelligence_events`,
// not two separate implementations.
// ════════════════════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function logEvent(row) {
  try {
    await supabaseAdmin.from('intelligence_events').insert(row);
  } catch (err) {
    console.warn('[IntelligenceEvent] insert failed:', err.message);
  }
}

module.exports = { logEvent };
