-- ============================================================
-- Reorder points: 10 for everything except ball caps.
--
-- Sets the reorder point (Admin -> Items, "Reorder when at or
-- below") of every real item to 10, active or not. Ball caps keep
-- the one they have. So do test items: the Test Product stays at
-- 2, so the low-stock flag can still be tried in test mode.
--
-- Changing a reorder point never sends a low-stock email. Those go
-- out only when a stock change takes an item from above its reorder
-- point to at or below it. So an item already at 10 or fewer shows
-- Low on the Inventory tab straight away, but won't email until it
-- has been restocked above 10 and drops back down.
--
-- The seed file (20261029100000_seed_highvis_items.sql) has the
-- same reorder points, so re-running it won't undo this.
--
-- Safe to re-run.
-- ============================================================

update apparel.items
set reorder_threshold = 10
where not is_test
  and name not ilike '%ball%cap%'    -- "Ball Cap", "Ballcap", "Baseball Cap"
  and reorder_threshold <> 10;

-- Shown under Results: every item and its reorder point, which
-- should be 10 for all but the ball cap.
select name, size, sku, reorder_threshold, active
from apparel.items
where not is_test
order by name, size;
