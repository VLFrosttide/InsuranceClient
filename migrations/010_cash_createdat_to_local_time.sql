-- Migration: Move existing cash-ledger creation times from UTC to local time
-- Description: Like migration 005 for insurance.CreationDate, the server used to
--              stamp the cash ledgers' CreatedAt with MySQL's CURRENT_TIMESTAMP.
--              On the hosting the database runs in UTC, so every entry was stored
--              3 hours behind the workers' local time (Bulgaria, UTC+3 in
--              summer). The client now computes the creation time itself and the
--              server stores it as sent; this shifts the rows created before that
--              change by +3 hours so all rows use local time.
--
--              Run ONCE, on the LIVE database only, AFTER the new server is
--              deployed. Do not run it on a database whose rows are already in
--              local time.
--
--              The old values are kept in cash_createdate_backup, so the change
--              can be undone (see the end of this file).
-- Date: 2026-10-17

-- 1) Keep the original values. Fails if the backup already exists, which also
--    stops the migration from being applied twice.
CREATE TABLE cash_createdate_backup (
  TableName VARCHAR(64) NOT NULL,
  id INT NOT NULL,
  CreatedAt DATETIME NOT NULL,
  BackedUpAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (TableName, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='CreatedAt of the cash ledgers before migration 010 (UTC -> local, +3h)';

INSERT INTO cash_createdate_backup (TableName, id, CreatedAt)
  SELECT 'cash_transactions', id, CreatedAt FROM cash_transactions
  UNION ALL
  SELECT 'cash_resets', id, CreatedAt FROM cash_resets
  UNION ALL
  SELECT 'card_resets', id, CreatedAt FROM card_resets
  UNION ALL
  SELECT 'total_cash_transactions', id, CreatedAt FROM total_cash_transactions;

-- 2) Shift every entry by +3 hours.
UPDATE cash_transactions       SET CreatedAt = CreatedAt + INTERVAL 3 HOUR;
UPDATE cash_resets             SET CreatedAt = CreatedAt + INTERVAL 3 HOUR;
UPDATE card_resets             SET CreatedAt = CreatedAt + INTERVAL 3 HOUR;
UPDATE total_cash_transactions SET CreatedAt = CreatedAt + INTERVAL 3 HOUR;

-- Verify: every row moved by exactly 3 hours (expect 0).
SELECT
  (SELECT COUNT(*)
     FROM cash_transactions t
     JOIN cash_createdate_backup b
       ON b.TableName = 'cash_transactions' AND b.id = t.id
    WHERE TIMESTAMPDIFF(HOUR, b.CreatedAt, t.CreatedAt) <> 3)
  + (SELECT COUNT(*)
       FROM cash_resets t
       JOIN cash_createdate_backup b
         ON b.TableName = 'cash_resets' AND b.id = t.id
      WHERE TIMESTAMPDIFF(HOUR, b.CreatedAt, t.CreatedAt) <> 3)
  + (SELECT COUNT(*)
       FROM card_resets t
       JOIN cash_createdate_backup b
         ON b.TableName = 'card_resets' AND b.id = t.id
      WHERE TIMESTAMPDIFF(HOUR, b.CreatedAt, t.CreatedAt) <> 3)
  + (SELECT COUNT(*)
       FROM total_cash_transactions t
       JOIN cash_createdate_backup b
         ON b.TableName = 'total_cash_transactions' AND b.id = t.id
      WHERE TIMESTAMPDIFF(HOUR, b.CreatedAt, t.CreatedAt) <> 3)
  AS NotShifted;

-- Undo (only if needed):
--   UPDATE cash_transactions t
--     JOIN cash_createdate_backup b ON b.TableName = 'cash_transactions' AND b.id = t.id
--      SET t.CreatedAt = b.CreatedAt;
--   UPDATE cash_resets t
--     JOIN cash_createdate_backup b ON b.TableName = 'cash_resets' AND b.id = t.id
--      SET t.CreatedAt = b.CreatedAt;
--   UPDATE card_resets t
--     JOIN cash_createdate_backup b ON b.TableName = 'card_resets' AND b.id = t.id
--      SET t.CreatedAt = b.CreatedAt;
--   UPDATE total_cash_transactions t
--     JOIN cash_createdate_backup b ON b.TableName = 'total_cash_transactions' AND b.id = t.id
--      SET t.CreatedAt = b.CreatedAt;
