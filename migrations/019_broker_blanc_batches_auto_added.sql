-- Migration: Automatically added blanc batches
-- Description: When a blanc number is not in any of a broker's blanc batches
--              and the policy has to be created anyway (the client asks and
--              re-sends it with ForceOutsideBlancBatch), the blanc is now
--              added to that broker's batches as its own one-number batch.
--              AutoAdded marks such a batch: it was never handed out by an
--              admin, so the client paints it pink and it stands out in the
--              brokers table and in the "Blanc batches" modal.
--
--              Two rules complete it:
--                * editing a batch's range (PATCH /brokers/:id/batches/:id)
--                  clears AutoAdded - the admin adopts the batch and the pink
--                  colour goes away;
--                * a blanc that already belongs to ANOTHER broker's batch is
--                  never added here: creating a policy with it is refused
--                  (BLANC_BELONGS_TO_ANOTHER_BROKER, naming that broker) and
--                  nothing is saved until the blanc number is changed.
--
--              db/setup.js applies the same CREATE TABLE / ALTER TABLE on
--              start-up, so a manual run is only needed when the schema must
--              be updated without restarting the server.
-- Date: 2026-11-20

-- 1) The flag (0 = handed out by an admin, 1 = added automatically for a blanc
--    that was forced in outside the batches). `IF NOT EXISTS` keeps this
--    re-runnable.
ALTER TABLE broker_blanc_batches
  ADD COLUMN IF NOT EXISTS AutoAdded TINYINT(1) NOT NULL DEFAULT 0;

-- 2) Existing batches were all handed out, so the default of 0 is correct;
--    nothing else has to be back-filled.

-- Verify: the column exists (expect 1).
SELECT COUNT(*) AS AutoAddedColumns
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'broker_blanc_batches'
   AND COLUMN_NAME = 'AutoAdded';

-- Undo (only if needed):
--   ALTER TABLE broker_blanc_batches DROP COLUMN AutoAdded;
