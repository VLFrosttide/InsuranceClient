-- Migration: Soft delete for user accounts and brokers
-- Description: Deleting a broker (Brokers screen) or a user (Users screen) no
--              longer removes the row. Like a soft-deleted insurance or broker
--              movement, the row is only flagged with Deleted/DeletedAt/
--              DeletedBy, so nothing is lost: a broker keeps its balance, blanc
--              batches, emails, tariffs and linked policies, and a user keeps
--              its password, broker link, balance and everything it authored.
--
--              From then on both are skipped by every read:
--                * users:  the Users list (GET /admin/users), and a deleted
--                          account cannot sign in (POST /login answers 403
--                          "Account deleted"). Its sessions are dropped on
--                          delete.
--                * brokers: the Brokers list (GET /brokers) and its export, new
--                          insurances are rejected for it, and its addresses no
--                          longer resolve to a broker, so its emails are not
--                          shown to workers.
--
--              An admin restores either one from the same screen, which clears
--              the three columns again.
--
--              db/setup.js applies the same ALTER TABLE statements on start-up,
--              so a manual run is only needed when the schema must be updated
--              without restarting the server.
-- Date: 2026-12-11

-- 1) The three soft-delete columns on `users` (re-runnable).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS Deleted TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS DeletedAt DATETIME NULL,
  ADD COLUMN IF NOT EXISTS DeletedBy VARCHAR(45) NULL;

-- 2) The same three columns on `brokers`.
ALTER TABLE brokers
  ADD COLUMN IF NOT EXISTS Deleted TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS DeletedAt DATETIME NULL,
  ADD COLUMN IF NOT EXISTS DeletedBy VARCHAR(45) NULL;

-- Verify: every column exists (expect 6).
SELECT TABLE_NAME, COUNT(*) AS SoftDeleteColumns
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('users', 'brokers')
   AND COLUMN_NAME IN ('Deleted', 'DeletedAt', 'DeletedBy')
 GROUP BY TABLE_NAME;

-- Undo a single deletion (nothing else has to be re-applied: a soft delete
-- never moved any money, changed a balance or detached a policy):
--   UPDATE users
--      SET Deleted = 0, DeletedAt = NULL, DeletedBy = NULL
--    WHERE Username = ?;
--   UPDATE brokers
--      SET Deleted = 0, DeletedAt = NULL, DeletedBy = NULL
--    WHERE id = ?;
