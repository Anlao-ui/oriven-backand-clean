// ════════════════════════════════════════════════════════════════
// Shared by the PGlite payment tests (onboarding-payment, stripe-plans):
// the auth/profiles base the migrations expect, a supabase-js-shaped adapter
// over PGlite (what services/purchases.js and onboardingFlow.js call), and a
// Stripe fake with Prices and Checkout sessions. No network, no Stripe.
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');

const BASE = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
CREATE TABLE profiles (
  id uuid PRIMARY KEY, email text, subscription_status text DEFAULT 'free', created_at timestamptz DEFAULT now(),
  stripe_customer_id text, stripe_subscription_id text,
  credits_balance integer NOT NULL DEFAULT 0, credits_cycle_start timestamptz, credits_cycle_end timestamptz,
  credits_provisioned_plan text, credits_last_reset_source text,
  onboarding_completed boolean DEFAULT false, onboarding_completed_at timestamptz, primary_goal text,
  first_value_at timestamptz, first_value_kind text
);
CREATE TABLE events (id bigserial PRIMARY KEY, event_name text, user_id uuid, session_id text, props jsonb, created_at timestamptz DEFAULT now());`;

// ── supabase-js-shaped adapter over PGlite (what both services use) ──
function adapter(pg) {
  const ident = (s) => '"' + String(s).replace(/"/g, '') + '"';
  const val = (v) => (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v);
  class Q {
    constructor(t) { this.t = t; this.op = 'select'; this.where = []; this.args = []; this.cols = '*'; this.lim = null; this.ord = null; this.ret = false; }
    select(c) { if (this.op === 'select') this.cols = c || '*'; else this.ret = true; return this; }
    insert(o) { this.op = 'insert'; this.p = o; return this; }
    update(o) { this.op = 'update'; this.p = o; return this; }
    _w(sql, v) { if (v !== undefined) { this.args.push(v); this.where.push(sql.replace('?', '$' + this.args.length)); } else this.where.push(sql); return this; }
    eq(c, v) { return this._w(ident(c) + ' = ?', v); }
    lt(c, v) { return this._w(ident(c) + ' < ?', v); }
    in(c, a) { this.args.push(a); this.where.push(ident(c) + ' = ANY($' + this.args.length + ')'); return this; }
    is(c, v) { return this._w(ident(c) + (v === null ? ' IS NULL' : ' IS ' + v)); }
    order(c, o) { this.ord = ident(c) + (o && o.ascending === false ? ' DESC NULLS LAST' : ' ASC'); return this; }
    limit(n) { this.lim = n; return this; }
    maybeSingle() { this.single = true; return this.run(); }
    then(a, b) { return this.run().then(a, b); }
    async run() {
      try {
        const W = this.where.length ? ' WHERE ' + this.where.join(' AND ') : '';
        if (this.op === 'insert') {
          const keys = Object.keys(this.p);
          await pg.query(`INSERT INTO ${ident(this.t)} (${keys.map(ident).join(', ')}) VALUES (${keys.map((k, i) => '$' + (i + 1)).join(', ')})`, keys.map((k) => val(this.p[k])));
          return { data: null, error: null };
        }
        if (this.op === 'update') {
          const keys = Object.keys(this.p); const base = this.args.length;
          const set = keys.map((k, i) => ident(k) + ' = $' + (base + i + 1)).join(', ');
          const r = await pg.query(`UPDATE ${ident(this.t)} SET ${set}${W}${this.ret ? ' RETURNING *' : ''}`, this.args.concat(keys.map((k) => val(this.p[k]))));
          return { data: this.ret ? (this.single ? r.rows[0] || null : r.rows) : null, error: null };
        }
        const cols = this.cols === '*' ? '*' : this.cols.split(',').map((c) => ident(c.trim())).join(', ');
        const r = await pg.query(`SELECT ${cols} FROM ${ident(this.t)}${W}${this.ord ? ' ORDER BY ' + this.ord : ''}${this.lim ? ' LIMIT ' + this.lim : ''}`, this.args);
        return { data: this.single ? (r.rows[0] || null) : r.rows, error: null };
      } catch (error) { return { data: null, error }; }
    }
  }
  return {
    from: (t) => new Q(t),
    rpc: async (fn, args) => {
      try {
        const keys = Object.keys(args || {});
        const r = await pg.query(`SELECT * FROM ${ident(fn)}(${keys.map((k, i) => ident(k) + ' => $' + (i + 1)).join(', ')})`, keys.map((k) => args[k]));
        const row = r.rows[0];
        if (row && Object.keys(row).length === 1 && fn in row) return { data: row[fn], error: null };
        return { data: r.rows, error: null };
      } catch (error) { return { data: null, error }; }
    },
  };
}

// A Stripe Price exactly as services/purchases.js expects it for a plan:
// active, one-time, EUR, the plan's amount, tax behaviour inclusive.
function priceFor(pricing, planId, over) {
  const plan = pricing.PLANS[planId];
  return Object.assign({ id: 'price_TEST' + planId.toUpperCase() + '0001', object: 'price', active: true, type: 'one_time', recurring: null,
    currency: 'eur', unit_amount: pricing.priceInclVatCents(plan), tax_behavior: 'inclusive', product: 'prod_TEST' + planId.toUpperCase() }, over || {});
}
// Configures test Price IDs for all five plans in services/pricing.js (this
// process only) and returns the matching fake prices.
function installTestPrices(pricing) {
  const prices = {};
  pricing.PLAN_ORDER.forEach((id) => { const p = priceFor(pricing, id); pricing.PLANS[id].stripePriceId = p.id; prices[p.id] = p; });
  return prices;
}

// Stripe fake: prices.retrieve, checkout.sessions.create/retrieve/expire.
function makeStripe(prices) {
  const S = { sessions: {}, created: [], expired: [], priceReads: 0, prices: prices || {} };
  const stripe = {
    prices: { retrieve: async (id) => { S.priceReads++; const p = S.prices[id]; if (!p) throw Object.assign(new Error('No such price: ' + id), { statusCode: 404, code: 'resource_missing' }); return Object.assign({}, p); } },
    checkout: { sessions: {
      create: async (p, opts) => { const id = 'cs_test_' + crypto.randomBytes(6).toString('hex'); S.sessions[id] = { id, status: 'open', params: p }; S.created.push({ id, p, opts }); return { id, url: 'https://checkout.stripe.test/' + id }; },
      retrieve: async (id) => { if (!S.sessions[id]) throw Object.assign(new Error('No such session'), { statusCode: 404 }); return { id, status: S.sessions[id].status }; },
      expire: async (id) => { S.expired.push(id); S.sessions[id].status = 'expired'; return { id }; },
    } },
  };
  // The session Stripe reports for a created checkout once it's paid: the
  // total is the Price's amount (VAT inside it, tax behaviour inclusive).
  function paidSession(created, over) {
    const li = created.p.line_items[0];
    const cents = li.price ? S.prices[li.price].unit_amount : li.price_data.unit_amount;
    return Object.assign({ id: created.id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
      client_reference_id: created.p.client_reference_id, metadata: created.p.metadata, customer: 'cus_' + created.p.client_reference_id.slice(0, 6),
      payment_intent: 'pi_' + created.id.slice(-8), amount_total: cents, total_details: { amount_tax: Math.round(cents - cents / 1.21) }, currency: 'eur' }, over || {});
  }
  return { stripe, S, paidSession };
}

module.exports = { BASE, adapter, priceFor, installTestPrices, makeStripe };
