-- Migration: Broker blanc batches
-- Description: A broker used to hold exactly one blanc range
--              (brokers.PolicyRangeStart / PolicyRangeEnd) and a stored
--              InactivePolicies counter. Admins now hand blancs out in
--              batches: each batch is its own [RangeStart, RangeEnd] row in
--              broker_blanc_batches, and a broker may hold any number of them.
--
--              Inactive blancs are no longer stored. The server calculates
--              them on every read from ALL of a broker's batches:
--                  SUM(RangeEnd - RangeStart + 1)
--                - blancs in those ranges used by a non-deleted insurance
--                  (Deleted = 0; an annulled policy keeps its blanc used up,
--                  only a deletion gives it back)
--
--              The server also creates this table on first use (CREATE TABLE
--              IF NOT EXISTS), but only this migration carries the existing
--              ranges over, so run it once on the live database.
--
--              The legacy brokers columns are left in place (no longer read
--              or written) so this migration can be undone; drop them later.
-- Date: 2026-10-10

CREATE TABLE IF NOT EXISTS broker_blanc_batches (
  id INT NOT NULL AUTO_INCREMENT,
  BrokerId INT NOT NULL,
  RangeStart BIGINT UNSIGNED NOT NULL,
  RangeEnd BIGINT UNSIGNED NOT NULL,
  CreatedBy VARCHAR(45) NOT NULL DEFAULT '',
  CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_broker_blanc_batches_broker (BrokerId),
  KEY idx_broker_blanc_batches_range (RangeStart, RangeEnd)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Blanc number ranges handed to brokers (one row per batch)';

-- 0) Pre-check: existing ranges that overlap another broker's range
--    (expect 0). Overlaps are copied as they are; fix them afterwards in the
--    Brokers screen, since a blanc should belong to only one batch.
SELECT a.id AS BrokerA, b.id AS BrokerB,
       a.PolicyRangeStart AS StartA, a.PolicyRangeEnd AS EndA,
       b.PolicyRangeStart AS StartB, b.PolicyRangeEnd AS EndB
  FROM brokers a
  JOIN brokers b ON a.id < b.id
 WHERE a.PolicyRangeEnd > 0 AND b.PolicyRangeEnd > 0
   AND a.PolicyRangeStart <= b.PolicyRangeEnd
   AND b.PolicyRangeStart <= a.PolicyRangeEnd;

-- 1) Carry every broker's existing single range over as its first batch.
--    0-0 is the "no range" placeholder written for seeded brokers - skipped.
--    Brokers that already have a batch are skipped, so a re-run is harmless.
INSERT INTO broker_blanc_batches (BrokerId, RangeStart, RangeEnd, CreatedBy)
SELECT br.id, br.PolicyRangeStart, br.PolicyRangeEnd, 'migration-008'
  FROM brokers br
 WHERE br.PolicyRangeEnd > 0
   AND br.PolicyRangeStart >= 0
   AND br.PolicyRangeEnd >= br.PolicyRangeStart
   AND NOT EXISTS (
         SELECT 1 FROM broker_blanc_batches bb WHERE bb.BrokerId = br.id
       );

-- Verify: the calculated inactive blancs next to the old stored counter.
-- Differences are expected where the old counter drifted (it was typed in
-- by hand).
SELECT br.id, br.Name,
       br.InactivePolicies AS OldStoredInactive,
       COALESCE(SUM(bb.RangeEnd - bb.RangeStart + 1), 0)
       - COALESCE(SUM((
           SELECT COUNT(DISTINCT CAST(TRIM(i.BlancNumber) AS UNSIGNED))
             FROM insurance i
            WHERE TRIM(i.BlancNumber) REGEXP '^[0-9]+$'
              AND CAST(TRIM(i.BlancNumber) AS UNSIGNED)
                  BETWEEN bb.RangeStart AND bb.RangeEnd
              AND i.Deleted = 0
         )), 0) AS CalculatedInactive
  FROM brokers br
  LEFT JOIN broker_blanc_batches bb ON bb.BrokerId = br.id
 GROUP BY br.id, br.Name, br.InactivePolicies
 ORDER BY br.id;

-- Undo (only if needed):
--   DROP TABLE broker_blanc_batches;
