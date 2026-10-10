-- Migration: Point cash ledger entries at the corrected blank numbers
-- Description: Migration 006 swapped PolicyNumber/BlancNumber on insurances
--              that were stored the wrong way round. The cash ledgers reference
--              a policy by its blank number in the Reason column (creation:
--              "<blanc>", price edit: "Edit <blanc>", annulment:
--              "Annul <blanc>"), so those entries still carried the old value.
--              This rewrites them to the new blank number using the mapping in
--              insurance_number_swap_backup (created by 006).
--
--              Run AFTER 006 and BEFORE insurance_number_swap_backup is
--              dropped. Once the backup is gone the old -> new mapping is lost.
-- Date: 2026-10-10

-- 1) Current cash ledger.
UPDATE cash_transactions c
  JOIN insurance_number_swap_backup b
    ON c.Reason IN (b.OldBlancNumber,
                    CONCAT('Edit ', b.OldBlancNumber),
                    CONCAT('Annul ', b.OldBlancNumber))
   SET c.Reason = CASE
         WHEN c.Reason = b.OldBlancNumber THEN b.OldPolicyNumber
         WHEN c.Reason = CONCAT('Edit ', b.OldBlancNumber) THEN CONCAT('Edit ', b.OldPolicyNumber)
         ELSE CONCAT('Annul ', b.OldPolicyNumber)
       END;

-- 2) Total cash ledger.
UPDATE total_cash_transactions c
  JOIN insurance_number_swap_backup b
    ON c.Reason IN (b.OldBlancNumber,
                    CONCAT('Edit ', b.OldBlancNumber),
                    CONCAT('Annul ', b.OldBlancNumber))
   SET c.Reason = CASE
         WHEN c.Reason = b.OldBlancNumber THEN b.OldPolicyNumber
         WHEN c.Reason = CONCAT('Edit ', b.OldBlancNumber) THEN CONCAT('Edit ', b.OldPolicyNumber)
         ELSE CONCAT('Annul ', b.OldPolicyNumber)
       END;

-- Verify: no ledger entry still mentions an old blank number (expect 0, 0).
SELECT COUNT(*) AS CashStillOld
  FROM cash_transactions c
  JOIN insurance_number_swap_backup b ON c.Reason LIKE CONCAT('%', b.OldBlancNumber, '%');

SELECT COUNT(*) AS TotalStillOld
  FROM total_cash_transactions c
  JOIN insurance_number_swap_backup b ON c.Reason LIKE CONCAT('%', b.OldBlancNumber, '%');

-- 3) The swap is confirmed, so the backup is no longer needed. (Without it,
--    neither 006 nor this migration can be undone.) Applied on the live
--    database on 2026-10-10 after the checks above returned 0.
DROP TABLE insurance_number_swap_backup;
