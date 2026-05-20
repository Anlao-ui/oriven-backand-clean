// ═══ SUPABASE CLIENT ══════════════════════════════════════════
// Initialized once — available globally as SB across all scripts.
// The anon key is intentionally public (publishable key).

var SUPABASE_URL  = "https://rsqfoqitooxmkyrkuyzi.supabase.co";
var SUPABASE_ANON_KEY = "sb_publishable_O7XoiC1YmV94lhwV5o8YBA_7zJ2HA7K";

// ── Dev mode flag ─────────────────────────────────────────────
// Detected once here — consumed by auth.js and usage.js to bypass
// all subscription and usage restrictions during local development.
// Never true on production (orivenai.com, Render, any non-localhost host).
var ORIVEN_DEV = (
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1"
);
if (ORIVEN_DEV) console.log("[ORIVEN] Dev mode active — subscription and usage limits bypassed");

// ── Backend base URL ──────────────────────────────────────────
// Single definition — every API fetch across all scripts uses this.
// Frontend (orivenai.com) and Express backend (Render) are separately hosted,
// so we cannot use window.location.origin — it would point to the static host.
//   Local:      http://localhost:5500
//   Production: https://oriven-backand.onrender.com
var API_BASE_URL = ORIVEN_DEV
  ? "http://localhost:5500"
  : "https://oriven-backand.onrender.com";

var SB = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log("[Supabase] Client initialized →", SUPABASE_URL);

// ── Safe API fetch wrapper ─────────────────────────────────────
// All backend calls go through here. Catches HTML error pages (from
// Render cold starts, 404s, or proxy errors) before they crash JSON.parse.
// Returns: { ok, status, data }   Throws: readable Error
async function apiFetch(path, options) {
  var url    = API_BASE_URL + path;
  var method = (options && options.method) || "GET";
  console.log("[API] →", method, url);

  var resp;
  try {
    resp = await fetch(url, options);
  } catch (netErr) {
    console.error("[API] ✗ Network error on", url, ":", netErr.message);
    throw new Error("Could not reach ORIVEN services. Please check your connection and try again.");
  }

  console.log("[API] ←", resp.status, url);

  // Read body as text first — safe regardless of content-type
  var text = await resp.text();
  var data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    // Server returned HTML (404 page, Render startup page, proxy error, etc.)
    console.error("[API] ✗ Non-JSON body (HTTP " + resp.status + ") from:", url);
    console.error("[API]   Preview:", text.slice(0, 400));
    if (resp.status === 404) {
      throw new Error("API endpoint not found (" + path + "). Please ensure the backend is fully deployed.");
    }
    throw new Error("Server returned an unexpected response (HTTP " + resp.status + "). The service may be starting — please try again in a moment.");
  }

  return { ok: resp.ok, status: resp.status, data: data };
}
