-- ONE-OFF SCHEMA CHANGE + BACKFILL (not run by the server on start).
--
-- Why: the broker balance history pairs a ledger row with a policy by
-- BlancNumber. When a policy's blanc was corrected by a server that did not
-- carry the rows along, its SALE row kept the old number and the history page
-- hid it - the insurance existed and the broker was charged, but that day's
-- history had no line for it. This column links a policy to the history row of
-- its sale, so the pairing survives any number of blanc corrections.
--
-- `npm run db:setup` applies this automatically (db/setup.js checks for the
-- column first). Run it here when the database is reached through phpMyAdmin.

-- ---------------------------------------------------------------------------
-- 1) The column and its unique key. One sale row belongs to at most one policy.
--    Run once: "Duplicate column name 'SaleMovementId'" means it is already
--    there and this block can be skipped.
-- ---------------------------------------------------------------------------
ALTER TABLE insurance
  ADD COLUMN SaleMovementId INT NULL AFTER DeletedBy,
  ADD UNIQUE KEY unique_insurance_sale_movement (SaleMovementId);

-- ---------------------------------------------------------------------------
-- 2) Backfill: link every policy that has no link yet to the oldest live
--    `policy` movement of the same broker and blanc - the sale row the history
--    page already shows for it (row ids grow with time, and a restore writes a
--    newer charge). Only NULL links are filled, so this is idempotent.
--
--    A policy with no live sale row (a void, a missing row, or a row left under
--    an older blanc) stays NULL: run fix_broker_history_gaps.sql first, then
--    this block again.
-- ---------------------------------------------------------------------------
UPDATE insurance i
  JOIN (
        SELECT i2.BlancNumber, MIN(m.id) AS MovementId
          FROM insurance i2
          JOIN broker_balance_movements m
            ON m.BrokerId = i2.BrokerId
           AND m.BlancNumber = i2.BlancNumber
           AND m.Type = 'policy'
           AND m.Deleted = 0
         WHERE i2.BrokerId IS NOT NULL
           AND i2.SaleMovementId IS NULL
         GROUP BY i2.BlancNumber
       ) sale
    ON sale.BlancNumber = i.BlancNumber
   SET i.SaleMovementId = sale.MovementId
 WHERE i.SaleMovementId IS NULL;

-- ---------------------------------------------------------------------------
-- 3) Verify: how many live broker policies have their sale row linked.
--    Unlinked ones are policies whose sale row is missing or ambiguous - run
--    check_broker_history_gaps.sql to see them, fix them, then run block 2
--    again.
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS LiveBrokerPolicies,
       SUM(SaleMovementId IS NOT NULL) AS Linked,
       SUM(SaleMovementId IS NULL) AS NotLinked
  FROM insurance
 WHERE Deleted = 0
   AND BrokerId IS NOT NULL;
