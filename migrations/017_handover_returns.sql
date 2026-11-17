-- Migration: Undo / return of money handed over to a person
-- Description: A hand-over (money given to a runner, the owner ...) used to be
--              final: the only way back was deleting the ledger row, which put
--              the WHOLE amount back into the drawer and lost the record of the
--              return.
--
--              A hand-over can now be returned, in parts, by an admin:
--
--                * to the office drawer - current cash grows again through a
--                  `cash_transactions` row of Type = 'handover_return'. Like the
--                  hand-over itself it writes NO row to
--                  `total_cash_transactions`, so Total daily cash and the
--                  expenses stay untouched, but the drawer's historical walk
--                  (getCurrentCashAsOf) counts it as money in;
--                * straight to the company bank account - no drawer is touched
--                  at all; only the return row below is written, so the
--                  handed-over total simply falls.
--
--              Every return is one row of `cash_handover_returns`, linked to the
--              original hand-over and (for a drawer return) to the ledger row
--              that put the money back. The original hand-over stays in its
--              ledger, so the whole history is kept and the statistics can show
--              handed over / returned / still out.
--
--              Broker-balance hand-overs (Type = 'handover' in
--              `broker_balance_movements`) are counted in the same statistics,
--              but are not returned through this table: they carry no branch and
--              are undone from the broker's history, which reverses the broker's
--              balance.
--
--              db/setup.js creates the same table on start-up, so a manual run is
--              only needed when the schema must be updated without restarting
--              the server.
-- Date: 2026-11-17

CREATE TABLE IF NOT EXISTS cash_handover_returns (
  id INT NOT NULL AUTO_INCREMENT,
  HandoverType VARCHAR(20) NOT NULL,
  CashTransactionId INT NULL,
  BrokerMovementId INT NULL,
  CashReturnTransactionId INT NULL,
  Branch VARCHAR(45) NOT NULL DEFAULT '',
  BrokerId INT NULL,
  Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  Amount DECIMAL(15,2) NOT NULL,
  Destination VARCHAR(20) NOT NULL,
  Username VARCHAR(45) NOT NULL,
  Reason VARCHAR(255) NOT NULL DEFAULT '',
  CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_handover_returns_cash (CashTransactionId),
  KEY idx_handover_returns_broker (BrokerMovementId),
  KEY idx_handover_returns_branch_time (Branch, CreatedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='Returns/undos of handed-over money (office drawer or company bank)';

-- Verify: everything ever handed over in cash (live rows), and how much of it
-- has come back. `Remaining` should never be negative.
--   SELECT h.Currency,
--          ROUND(SUM(h.Amount), 2) AS HandedOver,
--          ROUND(COALESCE(SUM(r.Returned), 0), 2) AS Returned,
--          ROUND(SUM(h.Amount) - COALESCE(SUM(r.Returned), 0), 2) AS Remaining
--     FROM cash_transactions h
--     LEFT JOIN (
--       SELECT CashTransactionId, SUM(Amount) AS Returned
--         FROM cash_handover_returns
--        WHERE HandoverType = 'cash'
--        GROUP BY CashTransactionId
--     ) r ON r.CashTransactionId = h.id
--    WHERE h.Type = 'handover' AND h.Deleted = 0
--    GROUP BY h.Currency;
--
-- Verify: returns whose drawer ledger row is missing (expect 0 for Destination
-- = 'drawer', all rows for 'bank').
--   SELECT Destination, COUNT(*) AS n
--     FROM cash_handover_returns
--    WHERE Destination = 'drawer' AND CashReturnTransactionId IS NULL
--    GROUP BY Destination;
--
-- Undo (only sensible if the feature was never used). Remove the return rows
-- first; if any destination was 'drawer', reverse the matching
-- `cash_transactions` rows (`DELETE FROM cash_transactions WHERE Type =
-- 'handover_return'` and subtract their amounts from `current_cash`) so the two
-- sides agree again.
--   DELETE FROM cash_handover_returns;
