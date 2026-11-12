-- Migration: Cash from Brokers (money handed over by brokers)
-- Description: Increasing a broker's balance used to add the same amount to the
--              branch's current cash, so broker money counted as Available cash.
--              It is now kept apart as the branch's own balance, "Cash from
--              Brokers":
--                * every manual top-up is recorded once, in
--                  broker_balance_movements (Type = 'increase'), carrying the
--                  Branch that took the money and its Currency;
--                * broker_balance_movements.Currency is new (top-ups may be EUR
--                  or TRY);
--                * broker_cash_resets records each "Reset to 0" of that balance
--                  (what was kept per currency and the last movement it covered),
--                  exactly like cash_resets does for the drawer;
--                * a delete/restore/edit of a top-up in the broker's history moves
--                  this balance with it, because it is computed from that ledger.
--
--              The server (db/setup.js) adds the two columns and the table on
--              start-up, and then runs the one-time separation described below
--              (db/separateBrokerCash.js). Deploying the new server is enough;
--              nothing here has to be run by hand.
--
--              The separation re-labels the top-ups recorded BEFORE the change and
--              takes their money back out of the cash drawer, so past days show
--              the same split in the daily report, in Available cash and in the
--              Current cash tab's "Transactions cash from brokers" list:
--                1. a top-up without a branch is matched to the current-cash
--                   increase it was mirrored into (same amount, CreatedAt, user
--                   and reason; a looser match on amount + CreatedAt + user is
--                   accepted only when it is unambiguous);
--                2. the movement gets that cash row's Branch and Currency;
--                3. the mirrored cash_transactions row is deleted;
--                4. a later reset's KeptAmount is reduced by the broker money it
--                   contained, and a matching broker_cash_resets row is written;
--                5. the rest is subtracted from current_cash (never below 0: a
--                   lower stored balance means part of it was already spent as
--                   cash, which the server logs as a warning).
--              A top-up that cannot be matched (its cash entry was edited into a
--              different amount, or the ledger has no row for it) is left alone:
--              it simply keeps counting as current cash, as it did before.
--
--              IMPORTANT: take a backup of `current_cash`, `cash_transactions`,
--              `cash_resets` and `broker_balance_movements` before deploying the
--              new server, so the separation can be undone if a number looks
--              wrong.
-- Date: 2026-11-12

-- 1) Schema (db/setup.js applies the same statements) ------------------------------
-- Kept here as the record of what changed. Do NOT run this section by hand: the
-- columns and the table already exist on a database the new server has started
-- against, so the statements would fail with "duplicate column/table".

ALTER TABLE broker_balance_movements
  ADD COLUMN Branch VARCHAR(45) NULL,
  ADD KEY idx_broker_movements_branch_time (Branch, CreatedAt);

ALTER TABLE broker_balance_movements
  ADD COLUMN Currency VARCHAR(3) NOT NULL DEFAULT 'EUR';

CREATE TABLE IF NOT EXISTS broker_cash_resets (
  id INT NOT NULL AUTO_INCREMENT,
  Branch VARCHAR(45) NOT NULL DEFAULT '',
  Username VARCHAR(45) NOT NULL,
  Currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
  KeptAmount DECIMAL(15,2) NOT NULL DEFAULT 0,
  LastMovementId INT NOT NULL DEFAULT 0,
  CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_broker_cash_resets_branch (Branch),
  KEY idx_broker_cash_resets_username (Username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Resets of a branch Cash from Brokers (kept amount per currency)';

-- 2) Inspect what the separation will match (run BEFORE deploying) -----------------
-- Every manual top-up that has no branch yet, with the current-cash increase it
-- will be matched to (one row per candidate; the server pairs them one-to-one,
-- oldest first).

-- SELECT m.id AS MovementId, m.Amount, m.Reason, m.CreatedAt, m.Author,
--        t.id AS CashId, t.Branch, t.Currency
--   FROM broker_balance_movements m
--   JOIN cash_transactions t
--     ON t.Type = 'increase'
--    AND t.Amount = m.Amount
--    AND t.CreatedAt = m.CreatedAt
--    AND t.Username = m.Author
--    AND t.Reason = m.Reason
--  WHERE m.Type = 'increase' AND m.Branch IS NULL AND m.Deleted = 0
--    AND m.Amount > 0
--  ORDER BY m.CreatedAt, m.id;

-- 3) Verify the separation AFTER the new server has started once ------------------

-- 3a) Manual top-ups the migration could not match (their mirrored cash entry was
--     edited into another amount, or there is none). They keep counting as current
--     cash, exactly as they did before.
-- SELECT COUNT(*) AS UnmatchedTopUps
--   FROM broker_balance_movements
--  WHERE Type = 'increase' AND Branch IS NULL AND Deleted = 0 AND Amount > 0;

-- 3b) The backfill marker, so it never runs again.
-- SELECT * FROM app_settings WHERE name = 'cash_from_brokers_backfill';

-- 3c) What each branch kept from its resets (Cash from Brokers history).
-- SELECT Branch, Currency, ROUND(SUM(KeptAmount), 2) AS Kept, MAX(CreatedAt) AS LastReset
--   FROM broker_cash_resets
--  GROUP BY Branch, Currency;

-- 4) Undo ------------------------------------------------------------------------
-- Restore the three cash tables and broker_balance_movements from the backup and
-- delete the marker, so the separation runs again on the next start:
--
--   DELETE FROM app_settings WHERE name = 'cash_from_brokers_backfill';
