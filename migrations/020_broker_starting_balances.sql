-- Migration: Broker starting balance (the balance before the first insurance)
-- Description: The balance history page now shows a "Starting balance" for every
--              broker: the balance the broker had BEFORE its first insurance
--              was created, together with the date that balance belongs to.
--
--              An admin sets it by clicking the value on that page
--              (PUT /brokers/:id/starting-balance { amount, date }). Saving it
--              recalculates the broker's CashBalance from the source data:
--
--                CashBalance = StartingBalance
--                            + manual payments (top-ups and hand-overs only;
--                              legacy reduce/adjust rows are ignored)
--                            - every live insurance of the broker, an annulled
--                              one at its annulment tax (AnnulFee; Price mirrors
--                              it since migration 018) only when the broker paid
--                              that fee (AnnulReason = 'broker')
--
--              The policy-derived ledger rows (policy / annulment / deletion /
--              price_change) are deliberately ignored by that calculation: the
--              insurances themselves are the truth for those, so a policy moved
--              to another broker, an edited price or a soft-deleted movement
--              cannot leave a stale charge behind. Nothing is written to
--              broker_balance_movements by this feature - the starting balance
--              is the base of the ledger, not a movement in it.
--
--              db/setup.js creates the same table on start-up, so a manual run
--              is only needed when the schema must be updated without
--              restarting the server. The server also creates it on first use.
-- Date: 2026-11-20

CREATE TABLE IF NOT EXISTS broker_starting_balances (
  BrokerId INT NOT NULL,
  Amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  EffectiveDate DATE NOT NULL,
  UpdatedBy VARCHAR(45) NOT NULL DEFAULT '',
  UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (BrokerId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='The balance a broker had before its first insurance (recalculation base)';

-- No back-fill: an unset starting balance is shown as "Not set" and leaves the
-- stored CashBalance (and the whole ledger) exactly as it is. An admin sets it
-- per broker from the balance history page when the starting figure is known.

-- Verify: the table exists (expect 1) and is empty on a fresh upgrade (expect 0).
SELECT COUNT(*) AS StartingBalanceTables
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'broker_starting_balances';

SELECT COUNT(*) AS StartingBalanceRows FROM broker_starting_balances;

-- Undo (only if the feature was never used; a set starting balance is data):
--   DROP TABLE broker_starting_balances;
