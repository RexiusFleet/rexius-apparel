-- ============================================================
-- Test product and test mode.
--
-- Items flagged is_test are for trying the app out. The page
-- keeps them out of check out, receiving, inventory, labels,
-- activity and reports, and lists them only under Admin -> Items,
-- until an admin turns on test mode. Test mode switches every
-- screen over to the test items (and only them), so receiving,
-- invoice reading, labels, check out and the chargeback report
-- can be tried end to end without touching real numbers. Their
-- transactions never appear in a real report or inventory total.
--
-- Invoices uploaded while test mode is on are flagged the same
-- way, so a test invoice never shows in the real invoice list or
-- the Receive tab's invoice picker.
--
-- Also adds the starting test product: "Test Product" in S, M and
-- L (SKUs TEST-S, TEST-M, TEST-L). Unit cost starts at 0 and is
-- set by test receipts like any item; the reorder point is 2 so
-- the low-stock flag can be tried too.
--
-- Safe to re-run: the columns are added once, and existing TEST-*
-- items are left as they are.
-- ============================================================

begin;

alter table apparel.items    add column if not exists is_test boolean not null default false;
alter table apparel.invoices add column if not exists is_test boolean not null default false;

insert into apparel.items (sku, name, category, size, unit_cost, reorder_threshold, active, is_test)
select 'TEST-' || size, 'Test Product', 'Test', size, 0, 2, true, true
from (values ('S'), ('M'), ('L')) as s(size)
on conflict (sku) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (run separately after commit):
-- select sku, name, is_test from apparel.items where is_test order by sku;
--   -> TEST-L, TEST-M, TEST-S
