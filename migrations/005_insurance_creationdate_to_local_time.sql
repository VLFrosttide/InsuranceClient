-- Migration: Move existing insurance creation times from UTC to local time
-- Description: The server used to stamp insurance.CreationDate with MySQL's
--              NOW(). On the hosting the database runs in UTC, so every policy
--              was stored 3 hours behind the workers' local time (Bulgaria,
--              UTC+3 in summer). The client now computes the creation time
--              itself and the server stores it as sent; this shifts the rows
--              created before that change by +3 hours so all rows use local
--              time.
--
--              Run ONCE, on the LIVE database only, AFTER the new server is
--              deployed (otherwise policies created in between are still
--              stored in UTC and are not covered). Do not run it on a database
--              whose rows are already in local time.
--
--              The old values are kept in insurance_creationdate_backup, so
--              the change can be undone (see the end of this file).
-- Date: 2026-10-10

-- 1) Keep the original values. Fails if the backup already exists, which also
--    stops the migration from being applied twice.
CREATE TABLE insurance_creationdate_backup (
  BlancNumber VARCHAR(45) NOT NULL,
  CreationDate DATETIME NOT NULL,
  BackedUpAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (BlancNumber)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='CreationDate before migration 005 (UTC -> local time, +3h)';

INSERT INTO insurance_creationdate_backup (BlancNumber, CreationDate)
SELECT BlancNumber, CreationDate FROM insurance;

-- 2) Shift every existing policy by +3 hours.
UPDATE insurance
   SET CreationDate = CreationDate + INTERVAL 3 HOUR;

-- Verify: every row moved by exactly 3 hours (expect 0).
SELECT COUNT(*) AS NotShifted
  FROM insurance i
  JOIN insurance_creationdate_backup b ON b.BlancNumber = i.BlancNumber
 WHERE TIMESTAMPDIFF(HOUR, b.CreationDate, i.CreationDate) <> 3;

-- Undo (only if needed):
--   UPDATE insurance i
--     JOIN insurance_creationdate_backup b ON b.BlancNumber = i.BlancNumber
--      SET i.CreationDate = b.CreationDate;
