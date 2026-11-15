-- Migration: Cash handed over to a person ("Hand over")
-- Description: The Current cash screen used to offer one way of taking money out
--              of a branch's drawer: the "Reduce" button. It is now called
--              "Expense" - the money leaves the drawer, is counted as an expense
--              of the day and lowers Total daily cash.
--
--              Money that is only HANDED to somebody (a runner taking the
--              takings to the safe, the owner collecting the day's cash ...) is
--              a different movement: it leaves the drawer (Available cash falls)
--              but the branch did not spend it, so it must not be counted as an
--              expense and must not move Total daily cash. It is recorded with
--              its own ledger type and with the person who took the money:
--
--                Type      = 'handover'    (instead of 'increase' / 'reduce')
--                Recipient = who received it (NULL for every other movement)
--
--              No new table is created: hand-overs live in the same
--              `cash_transactions` ledger, so the day's Transactions list and the
--              historical balance walk (getCurrentCashAsOf in
--              Requests/CurrentCash.js) keep working unchanged. A hand-over
--              writes NO row to `total_cash_transactions`, which is what keeps
--              Total daily cash untouched.
--
--              db/setup.js applies the same ALTER TABLE on start-up, so a manual
--              run is only needed when the schema must be updated without
--              restarting the server.
-- Date: 2026-11-15

-- 1) Who received the money (`IF NOT EXISTS` keeps this re-runnable).
ALTER TABLE cash_transactions
  ADD COLUMN IF NOT EXISTS Recipient VARCHAR(100) NULL AFTER Reason;

-- Verify: the column exists (expect 1).
SELECT COUNT(*) AS RecipientColumn
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'cash_transactions'
   AND COLUMN_NAME = 'Recipient';

-- Verify: how many hand-overs each branch recorded on a given day (expect 0 for
-- every existing day - nothing was a hand-over before this change).
--   SELECT Branch, Currency, SUM(Amount) AS HandedOver
--     FROM cash_transactions
--    WHERE Type = 'handover' AND Deleted = 0
--      AND CreatedAt >= '2026-11-15' AND CreatedAt < '2026-11-16'
--    GROUP BY Branch, Currency;

-- Undo (the money is NOT put back into the drawer by this): turn every hand-over
-- back into an ordinary expense. Only sensible if the feature was never used.
--   UPDATE cash_transactions SET Type = 'reduce', Recipient = NULL
--    WHERE Type = 'handover';
