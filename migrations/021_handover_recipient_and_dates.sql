-- Migration: Who received a broker hand-over + hand-over dates
-- Description: A broker hand-over (money the broker paid the OWNER directly)
--              now records the person who received it, just like a cash
--              hand-over does:
--
--                Recipient = who received the money (NULL for every other
--                            broker movement)
--
--              The history screen shows it ("Received by"), and the hand-over
--              form asks for it on creation and when an admin corrects one.
--
--              No new date column is needed: CreatedAt already exists on both
--              hand-over ledgers (`cash_transactions` for cash, and
--              `broker_balance_movements` + `broker_payments` for broker
--              payments). Admins can now pick that day when recording a
--              hand-over and correct it later; the time of day is kept, so a
--              backdated hand-over still sorts last within its day.
--
--              db/setup.js applies the same ALTER TABLEs on start-up, so a
--              manual run is only needed when the schema must be updated
--              without restarting the server.
-- Date: 2026-11-21

-- 1) Who received a broker hand-over.
ALTER TABLE broker_balance_movements
  ADD COLUMN IF NOT EXISTS Recipient VARCHAR(100) NULL AFTER Reason;

ALTER TABLE broker_payments
  ADD COLUMN IF NOT EXISTS Recipient VARCHAR(100) NULL AFTER Reason;

-- Verify: both columns exist (expect 2).
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('broker_balance_movements', 'broker_payments')
   AND COLUMN_NAME = 'Recipient';

-- Verify: where the existing broker hand-overs are dated (nothing changes here;
-- the date is only corrected from the client when an admin asks for it).
--   SELECT id, BrokerId, Amount, Currency, Recipient, CreatedAt
--     FROM broker_balance_movements
--    WHERE Type = 'handover' AND Deleted = 0
--    ORDER BY CreatedAt DESC, id DESC;

-- Undo: the column only holds the name shown next to a hand-over.
--   ALTER TABLE broker_balance_movements DROP COLUMN Recipient;
--   ALTER TABLE broker_payments DROP COLUMN Recipient;
