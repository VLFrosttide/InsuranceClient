-- READ-ONLY CHECK - NOT A MIGRATION.
--
-- "Reductions should not exist" / "admin correction rows should not exist".
-- The Reduce button, POST /brokers/:id/reduce and the hand-typed balance
-- correction in the broker edit form are all gone; the rows they already wrote
-- are KEPT as history (they still show in the balance history page) and the
-- recalculation ignores them. This script reports what those rows contain and
-- what each broker's balance becomes under the new rule, so you can decide
-- whether an old row needs its money re-recorded as a payment or folded into the
-- broker's starting balance.
--
-- Nothing here writes: every statement is a SELECT.
--
-- The balance rule these checks compare against (see recalculateBrokerBalance in
-- InsuranceServer/Requests/Brokers.js):
--
--   CashBalance = StartingBalance
--               + SUM(broker_balance_movements.Amount  WHERE Type IN ('increase','handover') AND Deleted = 0)
--               - SUM(insurance charge                  WHERE Deleted = 0,
--                       Annulled = 1 ? AnnulFee : Price)

-- ---------------------------------------------------------------------------
-- 0) What types does the ledger contain at all, and how much money is in each?
--    (A well-behaved database shows "reduce" and "adjust" with 0 rows.)
--    LiveTotal only counts rows the balance actually uses (Deleted = 0), which
--    is what the recalculation reads.
--    NB: "Rows" is a reserved word in MariaDB, hence RowCount.
-- ---------------------------------------------------------------------------
SELECT Type,
       COUNT(*) AS RowCount,
       SUM(Deleted = 1) AS DeletedCount,
       ROUND(SUM(CASE WHEN Deleted = 0 THEN Amount ELSE 0 END), 2) AS LiveTotal,
       ROUND(SUM(CASE WHEN Deleted = 1 THEN Amount ELSE 0 END), 2) AS DeletedTotal
  FROM broker_balance_movements
 GROUP BY Type
 ORDER BY RowCount DESC, Type;

-- ---------------------------------------------------------------------------
-- 1) The rows that the new rule no longer counts as payments.
-- ---------------------------------------------------------------------------
SELECT Type,
       COUNT(*) AS RowCount,
       ROUND(SUM(Amount), 2) AS TotalAmount,
       SUM(Deleted = 1) AS DeletedCount,
       MIN(CreatedAt) AS FirstAt,
       MAX(CreatedAt) AS LastAt
  FROM broker_balance_movements
 WHERE Type IN ('reduce', 'adjust')
 GROUP BY Type;

-- ---------------------------------------------------------------------------
-- 2) Each of those rows, with the broker it belongs to.
-- ---------------------------------------------------------------------------
SELECT m.id,
       m.BrokerId,
       b.Name AS Broker,
       m.CreatedAt,
       m.Type,
       m.Amount,
       m.Reason,
       m.Author,
       m.Deleted
  FROM broker_balance_movements m
  LEFT JOIN brokers b ON b.id = m.BrokerId
 WHERE m.Type IN ('reduce', 'adjust')
 ORDER BY m.BrokerId, m.CreatedAt;

-- ---------------------------------------------------------------------------
-- 2b) The same money, per broker: how much each broker's balance will move once
--     reduce/adjust stop counting as payments, with the dates and the authors
--     of those rows. Sorted by the biggest effect.
-- ---------------------------------------------------------------------------
SELECT m.BrokerId,
       b.Name AS Broker,
       COUNT(*) AS RowCount,
       MIN(m.CreatedAt) AS FirstAt,
       MAX(m.CreatedAt) AS LastAt,
       ROUND(SUM(CASE WHEN m.Type = 'reduce' THEN m.Amount ELSE 0 END), 2) AS ReduceAmount,
       ROUND(SUM(CASE WHEN m.Type = 'adjust' THEN m.Amount ELSE 0 END), 2) AS AdjustAmount,
       ROUND(SUM(m.Amount), 2) AS TotalAmount,
       GROUP_CONCAT(DISTINCT m.Author ORDER BY m.Author SEPARATOR ', ') AS Authors,
       GROUP_CONCAT(DISTINCT m.Reason ORDER BY m.Reason SEPARATOR ' | ') AS Reasons
  FROM broker_balance_movements m
  LEFT JOIN brokers b ON b.id = m.BrokerId
 WHERE m.Deleted = 0 AND m.Type IN ('reduce', 'adjust')
 GROUP BY m.BrokerId, b.Name
 ORDER BY ABS(SUM(m.Amount)) DESC;

-- ---------------------------------------------------------------------------
-- 3) What each broker's balance becomes under the new rule, and the difference
--    against the stored balance. Only brokers whose balance would change are
--    listed; an empty result means nothing moves when reduce/adjust stop
--    counting.
--
--    Needs broker_starting_balances: run `npm run db:setup` or
--    migrations/020_broker_starting_balances.sql first (both create it without
--    touching data). If you get #1146 (table does not exist), use block 4.
--
--    Uses a derived table instead of HAVING: HAVING without GROUP BY needs a
--    separating space/newline after the WHERE clause, and flattened one-line
--    SQL (as some clients and phpMyAdmin show it) loses it - "= 0HAVING ..."
--    is then a syntax error.
-- ---------------------------------------------------------------------------
SELECT x.id,
       x.Name,
       x.StoredBalance,
       x.StartingBalance,
       x.Payments,
       x.InsuranceCharges,
       x.CalculatedBalance,
       x.Difference
  FROM (
        SELECT b.id,
               b.Name,
               ROUND(b.CashBalance, 2) AS StoredBalance,
               ROUND(COALESCE(st.Amount, 0), 2) AS StartingBalance,
               ROUND(COALESCE(paid.Paid, 0), 2) AS Payments,
               ROUND(COALESCE(chg.Charged, 0), 2) AS InsuranceCharges,
               ROUND(COALESCE(st.Amount,0)+COALESCE(paid.Paid,0)-COALESCE(chg.Charged,0), 2) AS CalculatedBalance,
               ROUND(b.CashBalance - (COALESCE(st.Amount,0)+COALESCE(paid.Paid,0)-COALESCE(chg.Charged,0)), 2) AS Difference
          FROM brokers b
          LEFT JOIN broker_starting_balances st ON st.BrokerId = b.id
          LEFT JOIN (
                SELECT BrokerId, SUM(Amount) AS Paid
                  FROM broker_balance_movements
                 WHERE Deleted = 0 AND Type IN ('increase', 'handover')
                 GROUP BY BrokerId
               ) paid ON paid.BrokerId = b.id
          LEFT JOIN (
                SELECT BrokerId,
                       SUM(CASE WHEN Annulled = 1
                                THEN CAST(COALESCE(AnnulFee, Price, 0) AS DECIMAL(15,2))
                                ELSE CAST(COALESCE(Price, 0) AS DECIMAL(15,2))
                           END) AS Charged
                  FROM insurance
                 WHERE Deleted = 0 AND BrokerId IS NOT NULL
                 GROUP BY BrokerId
               ) chg ON chg.BrokerId = b.id
         WHERE b.Deleted = 0
       ) x
 WHERE ABS(x.Difference) > 0.005
 ORDER BY ABS(x.Difference) DESC;

-- ---------------------------------------------------------------------------
-- 4) Same question WITHOUT the starting-balance table (works on a database that
--    has not run db/setup yet). "Difference" is the part of the stored balance
--    that payments minus insurances does not explain:
--        * the broker's starting balance, if one is already stored,
--        * the money taken off by reduce/adjust rows (what we are checking),
--        * any older drift.
--    A broker with no starting balance and no reduce/adjust row should show 0.
--
--    Difference is ALSO the starting balance to enter for that broker
--    (PUT /brokers/:id/starting-balance, or the value on its balance history
--    page) to keep its current balance exactly as it is once reduce/adjust are
--    no longer counted:
--        stored = Difference + payments - policies
-- ---------------------------------------------------------------------------
SELECT x.id,
       x.Name,
       x.StoredBalance,
       x.Payments,
       x.InsuranceCharges,
       x.PaymentsMinusPolicies,
       x.Difference
  FROM (
        SELECT b.id,
               b.Name,
               ROUND(b.CashBalance, 2) AS StoredBalance,
               ROUND(COALESCE(paid.Paid, 0), 2) AS Payments,
               ROUND(COALESCE(chg.Charged, 0), 2) AS InsuranceCharges,
               ROUND(COALESCE(paid.Paid,0) - COALESCE(chg.Charged,0), 2) AS PaymentsMinusPolicies,
               ROUND(b.CashBalance - (COALESCE(paid.Paid,0) - COALESCE(chg.Charged,0)), 2) AS Difference
          FROM brokers b
          LEFT JOIN (
                SELECT BrokerId, SUM(Amount) AS Paid
                  FROM broker_balance_movements
                 WHERE Deleted = 0 AND Type IN ('increase', 'handover')
                 GROUP BY BrokerId
               ) paid ON paid.BrokerId = b.id
          LEFT JOIN (
                SELECT BrokerId,
                       SUM(CASE WHEN Annulled = 1
                                THEN CAST(COALESCE(AnnulFee, Price, 0) AS DECIMAL(15,2))
                                ELSE CAST(COALESCE(Price, 0) AS DECIMAL(15,2))
                           END) AS Charged
                  FROM insurance
                 WHERE Deleted = 0 AND BrokerId IS NOT NULL
                 GROUP BY BrokerId
               ) chg ON chg.BrokerId = b.id
         WHERE b.Deleted = 0
       ) x
 WHERE ABS(x.Difference) > 0.005
 ORDER BY ABS(x.Difference) DESC;

-- ---------------------------------------------------------------------------
-- Does the starting-balance table exist yet? (0 rows of output in block 3 above
-- can also mean "table missing"; this answers it directly.)
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS StartingBalanceTableExists
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'broker_starting_balances';

-- ---------------------------------------------------------------------------
-- What to do with the result:
--
-- * Block 1/2 list the live reduce/adjust rows (yours: 3 reduce, 35 adjust).
--   They stay in the database as history - nothing here deleted them and the
--   recalculation skips them. Decide per row whether the money was really a
--   payment (then record it as an "increase"/"handover" so it counts again) or
--   a mistake (then leave it out of the calculation, which is what happens now).
--
-- * Block 4's Difference is the amount by which a broker's recalculated balance
--   would differ from its stored balance today. Enter it as that broker's
--   starting balance to keep the current figure exactly, or leave it and let the
--   balance follow the formula starting + payments - policies.
-- ---------------------------------------------------------------------------

