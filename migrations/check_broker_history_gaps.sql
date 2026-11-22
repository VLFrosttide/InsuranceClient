-- READ-ONLY CHECK - NOT A MIGRATION.
--
-- "An insurance is in Insurances by date, but its charge is missing from the
-- broker's balance history for that day."
--
-- Why that happens (see also fix_broker_history_gaps.sql):
--   The history page pairs a ledger row (broker_balance_movements) with a policy
--   by BlancNumber. The charge row is written with the blanc the policy had at
--   that moment. When an admin later corrected the policy's blanc, an older
--   server updated `insurance` but not the ledger row, so the row kept a blanc
--   that belongs to no policy any more. The page SKIPS a policy row whose blanc
--   is not a live policy's (keeping it would walk money the balance does not
--   have), so the charge disappears from the history while `insurance` and
--   `brokers.CashBalance` still count it.
--
--   The server now relabels a policy's rows in the same transaction as the blanc
--   edit; the rows written before that fix are what this check finds.
--
-- Nothing here writes: every statement is a SELECT.
--
-- The rule these checks compare against (the balance history endpoint,
-- GET /brokers/:id/history):
--   for every live (Deleted = 0) broker-linked policy, the LIVE rows carrying
--   its BlancNumber must total minus the charge the balance applies to it:
--     charge = Price                              (active)
--              0                                  (annulled, worker/no fault)
--              COALESCE(AnnulFee, Price)          (annulled, broker paid)
--
-- Run each block separately in phpMyAdmin (each ends with a semicolon).

-- ---------------------------------------------------------------------------
-- 1) The gap list: one row per live broker-linked policy whose visible history
--    does not add up to its charge. An empty result means every charge is in
--    its broker's history.
--
--    Status says what the fix file will do with it:
--      MISSING ROW              - no row at all (never written, or removed); a
--                                 sale row has to be re-attached (fix block 2)
--                                 or written (fix block 3).
--      MISSING SALE ROW         - the policy has rows (e.g. an annulment
--                                 recorded after its blanc was corrected) but
--                                 no sale row: fix block 2 re-attaches it.
--      VOID (broker not charged) - the charge was deleted from the history on
--                                 purpose; the balance honours that, so nothing
--                                 is written. Restore it from the history page
--                                 ("Deleted movements") if the broker should pay.
--      AMOUNT MISMATCH          - a sale row exists but the rows do not total
--                                 the charge (an old price edit that wrote no
--                                 price_change row). Needs a human decision;
--                                 nothing is written automatically.
-- ---------------------------------------------------------------------------
SELECT y.BrokerId,
       y.BrokerCode,
       y.BrokerName,
       y.BlancNumber,
       y.PolicyNumber,
       y.CreationDate,
       y.Charge,
       y.VisibleNet,
       y.SaleRows,
       y.VisibleRows,
       y.VoidedRows,
       CASE
         WHEN y.SaleRows > 0 THEN 'AMOUNT MISMATCH'
         WHEN y.VisibleRows > 0 THEN 'MISSING SALE ROW'
         WHEN y.VoidedRows > 0 THEN 'VOID (broker not charged)'
         ELSE 'MISSING ROW'
       END AS Status
  FROM (
        SELECT i.BrokerId,
               b.Code AS BrokerCode,
               b.Name AS BrokerName,
               i.BlancNumber,
               i.PolicyNumber,
               i.CreationDate,
               ROUND(CASE
                       WHEN i.Annulled = 1
                       THEN CASE
                              WHEN LOWER(TRIM(COALESCE(i.AnnulReason, ''))) = 'broker'
                              THEN CAST(COALESCE(i.AnnulFee, i.Price, 0) AS DECIMAL(15,2))
                              ELSE 0
                            END
                       ELSE CAST(COALESCE(i.Price, 0) AS DECIMAL(15,2))
                     END, 2) AS Charge,
               ROUND(COALESCE(SUM(CASE WHEN m.Deleted = 0 THEN m.Amount ELSE 0 END), 0), 2) AS VisibleNet,
               SUM(CASE WHEN m.Deleted = 0 AND m.Type = 'policy' THEN 1 ELSE 0 END) AS SaleRows,
               SUM(CASE WHEN m.Deleted = 0 THEN 1 ELSE 0 END) AS VisibleRows,
               SUM(CASE WHEN m.Deleted = 1 THEN 1 ELSE 0 END) AS VoidedRows
          FROM insurance i
          JOIN brokers b
            ON b.id = i.BrokerId
          LEFT JOIN broker_balance_movements m
            ON m.BrokerId = i.BrokerId
           AND m.BlancNumber = i.BlancNumber
           AND m.Type IN ('policy', 'price_change', 'annulment', 'deletion')
         WHERE i.Deleted = 0
           AND i.BrokerId IS NOT NULL
         GROUP BY i.BrokerId, b.Code, b.Name, i.BlancNumber, i.PolicyNumber,
                  i.CreationDate, i.Price, i.Annulled, i.AnnulReason, i.AnnulFee
       ) y
 WHERE ABS(y.VisibleNet + y.Charge) > 0.005
 ORDER BY y.BrokerId, y.CreationDate;

-- ---------------------------------------------------------------------------
-- 2) Relabel candidates: sale rows left under a policy's PREVIOUS blanc.
--    These are the "MISSING ROW" policies of block 1 that can be fixed by
--    moving the row to the policy's current blanc - no money moves.
--
--    A row is listed only when the pairing is unambiguous:
--      * it is a live sale row whose blanc exists in no insurance at all
--        (not this broker's, not another broker's - so a moved-away policy's
--        row is never re-attached here),
--      * the policy has no sale row of its own under its current blanc yet,
--      * exactly one live policy of that broker was created at that second,
--      * exactly one such orphan sale row sits at that second.
-- ---------------------------------------------------------------------------
SELECT m.id AS MovementId,
       m.BrokerId,
       b.Code AS BrokerCode,
       b.Name AS BrokerName,
       m.BlancNumber AS StaleBlanc,
       i.BlancNumber AS PolicyBlanc,
       i.PolicyNumber,
       m.Amount,
       m.CreatedAt
  FROM broker_balance_movements m
  JOIN insurance i
    ON i.BrokerId = m.BrokerId
   AND i.Deleted = 0
   AND i.CreationDate = m.CreatedAt
  JOIN brokers b
    ON b.id = m.BrokerId
 WHERE m.Type = 'policy'
   AND m.Deleted = 0
   AND NOT EXISTS (SELECT 1 FROM insurance x
                    WHERE x.BlancNumber = m.BlancNumber)
   AND NOT EXISTS (SELECT 1 FROM broker_balance_movements z
                    WHERE z.BrokerId = i.BrokerId
                      AND z.BlancNumber = i.BlancNumber
                      AND z.Deleted = 0
                      AND z.Type = 'policy')
   AND (SELECT COUNT(*) FROM insurance i2
         WHERE i2.BrokerId = m.BrokerId
           AND i2.Deleted = 0
           AND i2.CreationDate = m.CreatedAt) = 1
   AND (SELECT COUNT(*) FROM broker_balance_movements m2
         WHERE m2.BrokerId = m.BrokerId
           AND m2.CreatedAt = m.CreatedAt
           AND m2.Type = 'policy'
           AND m2.Deleted = 0
           AND NOT EXISTS (SELECT 1 FROM insurance x2
                            WHERE x2.BlancNumber = m2.BlancNumber)) = 1
 ORDER BY m.BrokerId, m.CreatedAt;

-- ---------------------------------------------------------------------------
-- 3) Missing sale rows: a charged policy with NO row at all (neither live nor
--    voided) and no relabel candidate at its second. Fix block 3 writes the
--    sale row again. Only a plain, not annulled policy is listed; an annulled
--    one is left for manual review (its history is a sale + a folded refund).
-- ---------------------------------------------------------------------------
SELECT i.BrokerId,
       b.Code AS BrokerCode,
       b.Name AS BrokerName,
       i.BlancNumber,
       i.PolicyNumber,
       i.CreationDate,
       i.Author,
       ROUND(CAST(COALESCE(i.Price, 0) AS DECIMAL(15,2)), 2) AS Charge
  FROM insurance i
  JOIN brokers b
    ON b.id = i.BrokerId
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
                                       WHERE x3.BlancNumber = m3.BlancNumber))
 ORDER BY i.BrokerId, i.CreationDate;

-- ---------------------------------------------------------------------------
-- What to do with the result:
--
-- * Block 2 rows: run fix_broker_history_gaps.sql block 2 (UPDATE). This only
--   renames the row's BlancNumber; amounts, dates and brokers.CashBalance are
--   not touched, so no money changes. It fixes MISSING ROW and MISSING SALE ROW
--   policies whose old sale row is still there.
-- * Block 3 rows: run fix_broker_history_gaps.sql block 3 (INSERT). It writes
--   the sale row the balance already charged - again no money changes.
-- * VOID and AMOUNT MISMATCH rows from block 1 are NOT fixed by these scripts:
--   restoring a void or changing an amount would change what the broker owes.
--   Void: restore it from the balance history page if the broker should pay.
--   Mismatch: inspect that policy's rows; the amount shown disagrees with the
--   price the balance charges.
-- ---------------------------------------------------------------------------

