-- Migration: Card balance per branch
-- Description: The card balance used to be one global row (CardBalance.id = 1),
--              so a branch's "Reset to 0" could never clear its card money.
--              Each branch now has its own card balance in branch_card_balance,
--              and "Reset to 0" clears the branch's current cash AND its card
--              balance. card_resets records which branch was cleared.
--
--              The server (db/setup.js) runs these same steps on start-up, and
--              only while branch_card_balance is empty. Do NOT run this file by
--              hand while the OLD server is still live: the old server keeps
--              moving the global CardBalance, and the split would go stale.
--              Deploying the new server is enough.
--
--              The legacy CardBalance table is left in place (no longer read
--              or written) so the split can be checked or undone.
-- Date: 2026-10-10

ALTER TABLE card_resets ADD COLUMN Branch VARCHAR(45) NOT NULL DEFAULT '' AFTER id;

CREATE TABLE IF NOT EXISTS branch_card_balance (
  Branch VARCHAR(45) NOT NULL,
  CardBalance DECIMAL(15,2) NOT NULL DEFAULT 0,
  UpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (Branch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
COMMENT='Card balance per branch (replaces the global CardBalance row)';

-- 1) Each branch starts with its card share since the last clear
--    (total_cash.CardPart summed over currencies).
INSERT INTO branch_card_balance (Branch, CardBalance)
SELECT Branch, ROUND(SUM(CardPart), 2)
  FROM total_cash
 GROUP BY Branch
HAVING SUM(CardPart) <> 0;

-- 2) Card money in the old global balance that no branch accounts for is kept
--    on an unassigned ('') row instead of disappearing.
INSERT INTO branch_card_balance (Branch, CardBalance)
SELECT '', ROUND(cb.CardBalance - COALESCE(s.total, 0), 2)
  FROM CardBalance cb
  LEFT JOIN (SELECT SUM(CardBalance) AS total FROM branch_card_balance) s ON 1 = 1
 WHERE cb.id = 1
   AND ROUND(cb.CardBalance - COALESCE(s.total, 0), 2) <> 0
ON DUPLICATE KEY UPDATE CardBalance = CardBalance + VALUES(CardBalance);

-- Verify: the per-branch balances add up to the old global balance (expect 0).
SELECT ROUND((SELECT CardBalance FROM CardBalance WHERE id = 1)
           - (SELECT COALESCE(SUM(CardBalance), 0) FROM branch_card_balance), 2) AS Difference;

-- Undo (only if needed):
--   DROP TABLE branch_card_balance;
--   ALTER TABLE card_resets DROP COLUMN Branch;
