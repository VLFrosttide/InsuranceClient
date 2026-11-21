-- Migration: Company bank account (admin only)
-- Description: Adds the table that records money handed OUT of the company
--              bank account. The bank balance itself is derived, never stored:
--
--                balance(month) = cash kept at shift end   (cash_resets.KeptAmount)
--                               + manual cash increases to brokers
--                                 (broker_balance_movements.Type = 'increase'
--                                  with a Branch, booked at 00:00 the next day)
--                               - bank hand-overs            (bank_handovers)
--
--              Every month therefore starts from zero on its first day, while
--              the earlier months remain available in the history. The server
--              also creates this table on first use, so applying the file by
--              hand is optional.
-- Date: 2026-11-21

CREATE TABLE IF NOT EXISTS bank_handovers (
  id INT NOT NULL AUTO_INCREMENT,
  Amount DECIMAL(15,2) NOT NULL,
  Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  Recipient VARCHAR(100) NOT NULL,
  Reason VARCHAR(255) NOT NULL DEFAULT '',
  Author VARCHAR(45) NOT NULL DEFAULT '',
  CreatedAt DATETIME NOT NULL,
  Deleted TINYINT(1) NOT NULL DEFAULT 0,
  DeletedAt DATETIME NULL,
  DeletedBy VARCHAR(45) NULL,
  PRIMARY KEY (id),
  KEY idx_bank_handovers_created (CreatedAt),
  KEY idx_bank_handovers_currency (Currency)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Money handed over out of the company bank account';

-- Verify the first month's components:
--   SELECT Currency, ROUND(SUM(KeptAmount), 2) AS CashAtShiftEnd
--     FROM cash_resets
--    WHERE CreatedAt >= '2026-11-01' AND CreatedAt < '2026-12-01'
--    GROUP BY Currency;
--
--   SELECT Currency, ROUND(SUM(Amount), 2) AS BrokerIncreases
--     FROM broker_balance_movements
--    WHERE Type = 'increase' AND Deleted = 0 AND Amount > 0
--      AND Branch IS NOT NULL
--      AND CreatedAt >= '2026-11-01' AND CreatedAt < '2026-12-01'
--    GROUP BY Currency;
--
--   SELECT Currency, ROUND(SUM(Amount), 2) AS HandedOver
--     FROM bank_handovers
--    WHERE Deleted = 0
--      AND CreatedAt >= '2026-11-01' AND CreatedAt < '2026-12-01'
--    GROUP BY Currency;
--
-- Undo -------------------------------------------------------------------------
-- The table only records bank hand-outs. Dropping it removes that history:
--   DROP TABLE IF EXISTS bank_handovers;
