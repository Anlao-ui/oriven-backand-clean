-- ============================================================================
-- Oriven Team Seats migration
-- Apply once, by hand, via the Supabase SQL editor (no migration tooling in
-- this repo — same pattern as every prior schema change).
-- Safe to re-run: guarded (IF NOT EXISTS).
-- ============================================================================

CREATE TABLE IF NOT EXISTS team_members (
  id            bigserial PRIMARY KEY,
  owner_user_id uuid REFERENCES profiles(id) NOT NULL,
  invitee_email text NOT NULL,
  invitee_name  text,
  role          text NOT NULL DEFAULT 'Member',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_members_owner_idx ON team_members(owner_user_id, status);
