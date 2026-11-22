-- WRITES DATA - run check_broker_history_gaps.sql first and read its notes.
--
-- Puts a broker's charge back into its balance history for every insurance that
-- exists but whose charge the history page cannot show:
--
--   block 2  relabels a sale row left under the policy's PREVIOUS blanc (the
--            policy's blanc was corrected after the row was written, so the row
--            belongs to no live policy and the page hides it). The row keeps its
--            amount, author and date - only BlancNumber changes.
--
--   block 3  writes the missing sale row for a charged policy that has no row at
--            all (neither live nor voided).
--
-- No money changes. A broker's balance is rebuilt from `insurance` and
-- `broker_payments`; these statements only make the ledger show the charge that
-- balance already implies, and `brokers.CashBalance` is never written here.
--
-- They never un-hide a row: a soft-deleted policy row is a VOID the balance
-- honours, so restoring one would change money - that stays a deliberate action
-- on the balance history page. Idempotent: running them twice changes nothing
-- the second time.
--
-- Run the blocks in this order, one at a time, in phpMyAdmin. Take a dump of
-- `broker_balance_movements` and `insurance` first (the server keeps daily
-- backups in InsuranceServer/backups).
--
-- The numbering follows check_broker_history_gaps.sql, where block 1 is the
-- report: block 2 here is its relabel step, block 3 its missing-row step and
-- block 4 the verification.

-- ---------------------------------------------------------------------------
-- 2) Relabel the sale rows left under a policy's previous blanc.
--    Same conditions as check_broker_history_gaps.sql block 2: only an
--    unambiguous pairing is touched, and a row whose blanc belongs to another
--    broker's live policy (a moved-away policy) is never re-attached.
--    Expected: "Rows affected" equals the number of rows block 2 of the check
--    listed (0 when there is nothing to do).
-- ---------------------------------------------------------------------------
UPDATE broker_balance_movements m
  JOIN (
        SELECT m2.id AS MovementId,
               MIN(i.BlancNumber) AS NewBlanc
          FROM broker_balance_movements m2
          JOIN insurance i
            ON i.BrokerId = m2.BrokerId
           AND i.Deleted = 0
           AND i.CreationDate = m2.CreatedAt
         WHERE m2.Type = 'policy'
           AND m2.Deleted = 0
           AND NOT EXISTS (SELECT 1 FROM insurance x
                            WHERE x.BlancNumber = m2.BlancNumber)
           AND NOT EXISTS (SELECT 1 FROM broker_balance_movements z
                            WHERE z.BrokerId = i.BrokerId
                              AND z.BlancNumber = i.BlancNumber
                              AND z.Deleted = 0
                              AND z.Type = 'policy')
           AND (SELECT COUNT(*) FROM insurance i2
                 WHERE i2.BrokerId = m2.BrokerId
                   AND i2.Deleted = 0
                   AND i2.CreationDate = m2.CreatedAt) = 1
           AND (SELECT COUNT(*) FROM broker_balance_movements m3
                 WHERE m3.BrokerId = m2.BrokerId
                   AND m3.CreatedAt = m2.CreatedAt
                   AND m3.Type = 'policy'
                   AND m3.Deleted = 0
                   AND NOT EXISTS (SELECT 1 FROM insurance x3
                                    WHERE x3.BlancNumber = m3.BlancNumber)) = 1
         GROUP BY m2.id
       ) fix
    ON fix.MovementId = m.id
   SET m.BlancNumber = fix.NewBlanc;

-- ---------------------------------------------------------------------------
-- 3) Write the missing sale row for a charged policy that has none.
--    Same conditions as check_broker_history_gaps.sql block 3: plain (not
--    annulled) policy, no row at all under its blanc, no sale row of the same
--    money at its second, and no relabel candidate waiting at its second (run
--    block 2 first).
--    Expected: "Rows affected" equals the number of rows block 3 of the check
--    listed (0 when there is nothing to do).
-- ---------------------------------------------------------------------------
INSERT INTO broker_balance_movements
       (BrokerId, Amount, Type, Reason, Author, BlancNumber, CreatedAt)
SELECT i.BrokerId,
       -CAST(COALESCE(i.Price, 0) AS DECIMAL(15,2)),
       'policy',
       i.BlancNumber,
       LEFT(COALESCE(i.Author, ''), 45),
       i.BlancNumber,
       i.CreationDate
  FROM insurance i
 WHERE i.Deleted = 0
   AND i.BrokerId IS NOT NULL
   AND i.Annulled = 0
   AND CAST(COALESCE(i.Price, 0) AS DECIMAL(15,2)) > 0
   AND NOT EXISTS (SELECT 1 FROM broker_balance_movements m
                    WHERE m.BrokerId = i.BrokerId
                      AND m.BlancNumber = i.BlancNumber
                      AND m.Type IN ('policy', 'price_change', 'annulment', 'deletion'))
   AND NOT EXISTS (SELECT 1 FROM broker_balance_movements m2
                    WHERE m2.BrokerId = i.BrokerId
                      AND m2.Type = 'policy'
                      AND m2.Deleted = 0
                      AND m2.Amount = -CAST(COALESCE(i.Price, 0) AS DECIMAL(15,2))
                      AND m2.CreatedAt = i.CreationDate)
   AND NOT EXISTS (SELECT 1 FROM broker_balance_movements m3
                    WHERE m3.BrokerId = i.BrokerId
                      AND m3.Type = 'policy'
                      AND m3.Deleted = 0
                      AND m3.CreatedAt = i.CreationDate
                      AND NOT EXISTS (SELECT 1 FROM insurance x3
                                       WHERE x3.BlancNumber = m3.BlancNumber));

-- ---------------------------------------------------------------------------
-- 4) Verify: re-run check_broker_history_gaps.sql block 1. Only
--    "VOID (broker not charged)" and "AMOUNT MISMATCH" lines may remain; every
--    MISSING ROW / MISSING SALE ROW line should be gone.
--
--    A quick count of charges still not visible (expected 0). A voided charge
--    does not count: it is deliberately not charged, so it must stay hidden.
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS StillMissing
  FROM insurance i
 WHERE i.Deleted = 0
   AND i.BrokerId IS NOT NULL
   AND CAST(CASE
              WHEN i.Annulled = 1
              THEN CASE
                     WHEN LOWER(TRIM(COALESCE(i.AnnulReason, ''))) = 'broker'
                     THEN CAST(COALESCE(i.AnnulFee, i.Price, 0) AS DECIMAL(15,2))
                     ELSE 0
                   END
              ELSE CAST(COALESCE(i.Price, 0) AS DECIMAL(15,2))
            END AS DECIMAL(15,2)) <> 0
   AND NOT EXISTS (SELECT 1 FROM broker_balance_movements m
                    WHERE m.BrokerId = i.BrokerId
                      AND m.BlancNumber = i.BlancNumber
                      AND m.Deleted = 0
                      AND m.Type IN ('policy', 'price_change', 'annulment', 'deletion'))
   AND NOT EXISTS (SELECT 1 FROM broker_balance_movements v
                    WHERE v.BrokerId = i.BrokerId
                      AND v.BlancNumber = i.BlancNumber
                      AND v.Deleted = 1
                      AND v.Type IN ('policy', 'price_change', 'annulment', 'deletion'));

