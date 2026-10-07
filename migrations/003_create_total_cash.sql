-- Migration: Create the TOTAL cash tables (second record of cash flow)
-- Description: Total cash is a strict superset of current cash - it counts every
--              type of payment (cash money, card payments and broker-balance
--              payments). `total_cash` stores only the two parts that
--              `current_cash` does not already carry, and the total is computed
--              on every read as
--                  TotalCash(branch, currency) = current_cash.CurrentCash
--                                              + total_cash.CardPart
--                                              + total_cash.BrokerPart
--              so resetting current cash, or clearing the card balance (which
--              zeroes every CardPart), drags Total cash down automatically.
-- Date: 2026-10-07

-- Per branch / per currency parts that current cash does not carry.
CREATE TABLE IF NOT EXISTS total_cash (
  id INT NOT NULL,
  Branch VARCHAR(45) NOT NULL DEFAULT '',
  Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  CardPart DECIMAL(15,2) NOT NULL DEFAULT 0
    COMMENT 'Share of CardBalance held by this branch/currency',
  BrokerPart DECIMAL(15,2) NOT NULL DEFAULT 0
    COMMENT 'Policies funded from a broker balance (email cash payments)',
  UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id, Branch, Currency),
  KEY idx_total_cash_branch (Branch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Second record of cash flow: the parts Total cash adds on top of current cash';

-- Total cash ledger: one row per movement, tagged with the channel it came
-- through so the two records of cash flow can be compared entry by entry.
CREATE TABLE IF NOT EXISTS total_cash_transactions (
  id INT NOT NULL AUTO_INCREMENT,
  Branch VARCHAR(45) NOT NULL DEFAULT '',
  Type VARCHAR(20) NOT NULL COMMENT 'increase | reduce',
  Amount DECIMAL(15,2) NOT NULL,
  Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  Source VARCHAR(10) NOT NULL COMMENT 'Cash | Card | Broker',
  Username VARCHAR(45) NOT NULL,
  Reason VARCHAR(255) NOT NULL,
  CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_total_cash_transactions_branch (Branch),
  KEY idx_total_cash_transactions_source (Source),
  KEY idx_total_cash_transactions_username (Username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Ledger of every movement counted in Total cash';

-- Backfill the parts from the policies that already exist, so the superset
-- identity holds for historical data too and not only for new payments.
--
-- CardPart: every non-annulled Card policy contributed its price; an annulled
--           one contributed its price and was then refunded (price - fee), so
--           its net contribution is the annul fee.
INSERT INTO total_cash (id, Branch, Currency, CardPart, BrokerPart)
SELECT 1, Branch, CurrencyType,
       ROUND(SUM(CASE WHEN Annulled = 0 THEN CAST(Price AS DECIMAL(15,2))
                      ELSE COALESCE(AnnulFee, 0) END), 2),
       0
  FROM insurance
 WHERE PaymentType = 'Card' AND BrokerId IS NULL AND Deleted = 0
 GROUP BY Branch, CurrencyType
ON DUPLICATE KEY UPDATE CardPart = VALUES(CardPart);

-- BrokerPart: policies whose sender matched a broker were funded by that
-- broker's balance. Email policies are broker-balance ONLY (never cash or
-- card), whatever PaymentType a legacy row was stored with.
INSERT INTO total_cash (id, Branch, Currency, CardPart, BrokerPart)
SELECT 1, Branch, CurrencyType, 0,
       ROUND(SUM(CASE WHEN Annulled = 0 THEN CAST(Price AS DECIMAL(15,2))
                      ELSE COALESCE(AnnulFee, 0) END), 2)
  FROM insurance
 WHERE BrokerId IS NOT NULL AND Deleted = 0
 GROUP BY Branch, CurrencyType
ON DUPLICATE KEY UPDATE BrokerPart = VALUES(BrokerPart);

-- Verify
SHOW CREATE TABLE total_cash;
SHOW CREATE TABLE total_cash_transactions;
