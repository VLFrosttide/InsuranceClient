-- ONE-OFF DATA CHANGE (not run by the server on start).
--
-- Why: the Turkish-lira (TRY) walk-in tariff for Auto policies was raised to
-- 1 600 TRY / 2 050 TRY / 2 300 TRY for 15 days / 1 month / 3 months. TRY
-- rows exist only for the Lesovo and Kapitan Andreevo border crossings (every
-- other branch and vehicle type quotes EUR), so they are identified by their
-- currency alone.
--
-- The branch tariffs in db/BrokerInfo.js only seed a database that has no TRY
-- rows yet (seedBranchTariffsIfMissing never overwrites an existing price), so
-- a live database keeps the old 1 600 / 2 000 / 2 200 rows until this script
-- is run (phpMyAdmin or the mysql client). A database that does seed its
-- branch tariffs from BrokerInfo.js gets the new prices directly.
-- EUR rows and the broker tariffs are not touched.

-- ---------------------------------------------------------------------------
-- 1) Raise the three TRY Auto durations. Running it again is a no-op.
-- ---------------------------------------------------------------------------
UPDATE branch_tariffs
   SET Price = CASE Duration
                 WHEN 15 THEN 1600.00
                 WHEN 30 THEN 2050.00
                 WHEN 90 THEN 2300.00
               END
 WHERE Currency = 'TRY'
   AND InsuranceType = 'Auto'
   AND Duration IN (15, 30, 90);

-- ---------------------------------------------------------------------------
-- 2) Verify: expect six rows (two crossings x three durations), reading
--    1 600 / 2 050 / 2 300. Fewer rows mean that crossing never had TRY
--    tariffs; add the missing ones with the commented INSERT in block 3.
-- ---------------------------------------------------------------------------
SELECT Branch, InsuranceType, Duration, Price, Currency
  FROM branch_tariffs
 WHERE Currency = 'TRY'
 ORDER BY Branch, Duration;

-- ---------------------------------------------------------------------------
-- 3) Only if a crossing has no TRY rows at all (the six rows of block 2 are
--    not all there): insert them. The admin tariff endpoints write EUR rows,
--    so TRY rows are set here.
-- ---------------------------------------------------------------------------
-- INSERT INTO branch_tariffs (Branch, InsuranceType, Duration, Price, Currency)
-- VALUES
--   ('ГКПП Лесово',           'Auto', 15, 1600.00, 'TRY'),
--   ('ГКПП Лесово',           'Auto', 30, 2050.00, 'TRY'),
--   ('ГКПП Лесово',           'Auto', 90, 2300.00, 'TRY'),
--   ('ГКПП Капитан Андреево', 'Auto', 15, 1600.00, 'TRY'),
--   ('ГКПП Капитан Андреево', 'Auto', 30, 2050.00, 'TRY'),
--   ('ГКПП Капитан Андреево', 'Auto', 90, 2300.00, 'TRY')
-- ON DUPLICATE KEY UPDATE Price = VALUES(Price);

-- ---------------------------------------------------------------------------
-- 4) Undo: put the previous prices back (1 600 / 2 000 / 2 200).
-- ---------------------------------------------------------------------------
-- UPDATE branch_tariffs
--    SET Price = CASE Duration
--                  WHEN 15 THEN 1600.00
--                  WHEN 30 THEN 2000.00
--                  WHEN 90 THEN 2200.00
--                END
--  WHERE Currency = 'TRY'
--    AND InsuranceType = 'Auto'
--    AND Duration IN (15, 30, 90);