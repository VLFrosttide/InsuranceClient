-- Migration: Soft delete for the current-cash ledger
-- Description: An admin can now delete a single entry of the Current cash
--              screen's Transactions list. The entry is never removed: it is
--              flagged with Deleted/DeletedAt/DeletedBy, exactly like a
--              soft-deleted insurance or broker movement, and the money it
--              moved is reversed (an increase is taken back off the drawer, a
--              reduction is put back in) with a matching row in the Total cash
--              ledger (`total_cash_transactions`).
--
--              From then on the row is skipped by every read: the day's
--              transaction and expenses lists, the Current cash / Total cash
--              daily net and the historical balance walk
--              (getCurrentCashAsOf in Requests/CurrentCash.js).
--
--              db/setup.js applies the same ALTER TABLE statements on start-up,
--              so a manual run is only needed when the schema must be updated
--              without restarting the server.
-- Date: 2026-12-11

-- 1) The three soft-delete columns (`IF NOT EXISTS` keeps this re-runnable).
ALTER TABLE cash_transactions
  ADD COLUMN IF NOT EXISTS Deleted TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS DeletedAt DATETIME NULL,
  ADD COLUMN IF NOT EXISTS DeletedBy VARCHAR(45) NULL;

-- Verify: the columns exist (expect 3).
SELECT COUNT(*) AS SoftDeleteColumns
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'cash_transactions'
   AND COLUMN_NAME IN ('Deleted', 'DeletedAt', 'DeletedBy');

-- Undo a single deletion (the money is NOT re-applied by this - restoring a
-- deleted entry would have to move the drawer again, the reverse of what the
-- deletion did):
--   UPDATE cash_transactions
--      SET Deleted = 0, DeletedAt = NULL, DeletedBy = NULL
--    WHERE id = ?;
