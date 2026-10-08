-- Migration: Record the branch as the broker of walk-in insurances
-- Description: Walk-in policies (created from the "+ Add insurance" button, not
--              from a broker's email) used to be stored with an empty Broker.
--              New walk-ins now store the issuing branch as their broker, so
--              this backfills the existing ones the same way. BrokerId stays
--              NULL - it marks a policy as paid from a real broker's balance,
--              and walk-ins are always paid in cash or by card.
-- Date: 2026-10-08

UPDATE insurance
   SET Broker = Branch
 WHERE BrokerId IS NULL
   AND (Broker IS NULL OR Broker = '')
   AND Branch IS NOT NULL
   AND Branch <> '';

-- Verify
SELECT COUNT(*) AS WalkInsWithoutBroker
  FROM insurance
 WHERE BrokerId IS NULL AND (Broker IS NULL OR Broker = '');
