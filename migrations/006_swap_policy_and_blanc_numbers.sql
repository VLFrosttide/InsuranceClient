-- Migration: Swap policy and blank numbers that were entered the wrong way round
-- Description: A policy number is exactly 8 characters and a blank number is
--              exactly 6. Some insurances were stored with the two values in
--              each other's columns (PolicyNumber has 6 characters and
--              BlancNumber has 8). This swaps them back for those rows only.
--
--              Rows where either field is empty or does not have one of the
--              exact lengths above are NOT touched - they are fixed manually.
--
--              BlancNumber is the PRIMARY KEY, so run the collision check below
--              first (expect 0). The original values are kept in
--              insurance_number_swap_backup, so the change can be undone (see
--              the end of this file).
-- Date: 2026-10-10

-- 0) Pre-check: no swapped row may take a blank number already in use (expect 0).
SELECT COUNT(*) AS Collisions
  FROM insurance s
  JOIN insurance o ON o.BlancNumber = s.PolicyNumber
 WHERE CHAR_LENGTH(s.PolicyNumber) = 6
   AND CHAR_LENGTH(s.BlancNumber) = 8;

-- 1) Keep the original values. Fails if the backup already exists, which also
--    stops the migration from being applied twice.
CREATE TABLE insurance_number_swap_backup (
  OldBlancNumber VARCHAR(45) NOT NULL,
  OldPolicyNumber VARCHAR(45) NOT NULL,
  BackedUpAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (OldBlancNumber)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='PolicyNumber/BlancNumber before migration 006 (swapped values)';

INSERT INTO insurance_number_swap_backup (OldBlancNumber, OldPolicyNumber)
SELECT BlancNumber, PolicyNumber
  FROM insurance
 WHERE CHAR_LENGTH(PolicyNumber) = 6
   AND CHAR_LENGTH(BlancNumber) = 8;

-- 2) Swap the two values. MySQL applies single-table SET assignments left to
--    right, so "SET a = b, b = a" would not swap; the original values are read
--    from the backup instead.
UPDATE insurance i
  JOIN insurance_number_swap_backup b ON b.OldBlancNumber = i.BlancNumber
   SET i.BlancNumber = b.OldPolicyNumber,
       i.PolicyNumber = b.OldBlancNumber;

-- Verify: no row is left the wrong way round (expect 0), and every backed-up
-- row now carries the swapped values (expect 0).
SELECT COUNT(*) AS StillSwapped
  FROM insurance
 WHERE CHAR_LENGTH(PolicyNumber) = 6
   AND CHAR_LENGTH(BlancNumber) = 8;

SELECT COUNT(*) AS NotSwapped
  FROM insurance_number_swap_backup b
  LEFT JOIN insurance i
         ON i.BlancNumber = b.OldPolicyNumber
        AND i.PolicyNumber = b.OldBlancNumber
 WHERE i.BlancNumber IS NULL;

-- Undo (only if needed):
--   UPDATE insurance i
--     JOIN insurance_number_swap_backup b ON b.OldPolicyNumber = i.BlancNumber
--      SET i.BlancNumber = b.OldBlancNumber,
--          i.PolicyNumber = b.OldPolicyNumber;
