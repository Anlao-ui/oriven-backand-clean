-- ═══════════════════════════════════════════════════════════════════
-- ROLLBACK for 2026-11-account-deletion.sql
--
-- Removes delete_account_data(). The profiles.deleted_at column is KEPT:
-- accounts already deleted keep their marker (dropping it would make their
-- anonymised tombstones look like live accounts). Deleted data cannot be
-- restored by a rollback. After this, deploy a backend that does not call
-- delete_account_data. One transaction.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;
DROP FUNCTION IF EXISTS delete_account_data(uuid);
COMMIT;

NOTIFY pgrst, 'reload schema';
