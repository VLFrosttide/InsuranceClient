-- Migration: The annulment tax becomes the policy's price
-- Description: An annulled policy's `Price` used to keep the amount it was sold
--              for, while the tax kept from the refund lived only in `AnnulFee`.
--              Screens and exports therefore had to special-case annulled rows
--              to show the tax instead of the sale price.
--
--              From now on the tax IS the policy's price:
--
--                Annulled = 1 -> Price = AnnulFee (the tax that was kept)
--                                OriginalPrice = the price it was sold for
--
--              `OriginalPrice` is new and keeps the old amount so refunds,
--              broker bills, price corrections, deletes/restores and
--              un-annulling (an admin unticking "Annulled") still work with the
--              real sale price. Un-annulling puts OriginalPrice back into Price
--              and clears both annulment columns again.
--
--              Existing annulled rows are converted once. The `OriginalPrice IS
--              NULL` guard makes the statement idempotent: a restart can never
--              overwrite the saved original with the tax.
--
--              The API server applies the same upgrade on start-up (db/setup.js),
--              so a manual run is only needed when the schema must be updated
--              without restarting the server.
-- Date: 2026-11-19

ALTER TABLE insurance
  ADD COLUMN OriginalPrice VARCHAR(45) NULL AFTER Price;

UPDATE insurance
   SET OriginalPrice = Price,
       Price = CAST(COALESCE(AnnulFee, 0) AS CHAR)
 WHERE Annulled = 1 AND OriginalPrice IS NULL;

-- Verify: annulled rows have their tax as Price and the sale price kept.
--   SELECT BlancNumber, Price, AnnulFee, OriginalPrice
--     FROM insurance
--    WHERE Annulled = 1 AND (Price <> CAST(AnnulFee AS CHAR) OR OriginalPrice IS NULL)
--    LIMIT 20;
--
-- Verify: un-annulled rows should never keep an OriginalPrice.
--   SELECT COUNT(*) AS n FROM insurance
--    WHERE Annulled = 0 AND OriginalPrice IS NOT NULL;
--
-- Undo (only sensible if the feature was never used): put the sale price back
-- into Price and drop the column. Annulled rows that predate the migration have
-- no separate record of their sale price apart from OriginalPrice, so this
-- restores exactly what the policy was sold for.
--   UPDATE insurance SET Price = OriginalPrice WHERE Annulled = 1 AND OriginalPrice IS NOT NULL;
--   ALTER TABLE insurance DROP COLUMN OriginalPrice;
