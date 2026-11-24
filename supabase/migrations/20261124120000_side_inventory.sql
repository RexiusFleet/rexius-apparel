-- ============================================================
-- Side inventory, and items with no reorder point.
--
-- Some items aren't kept stocked all the time: they're ordered
-- when someone needs one (Fleet Services shirts, one-offs, odd
-- items). Two separate settings on each item cover that:
--
--   * apparel.items.reorder_threshold can now be blank (null):
--     "order as needed". Such an item is never Low, never needs
--     a Refill and never sends a low-stock email. In
--     apparel.inventory its low_stock is null (no reorder point
--     to be under) and its refill is false. The low-stock
--     trigger needs no change: a blank reorder point never
--     matches its "at or below" test.
--   * apparel.items.side: true files the item under Side
--     inventory, so it stays off the main Inventory list and
--     sits at the bottom of the check out list. Nothing else
--     changes: it is received, checked out, costed and reported
--     like any other item.
--   * apparel.inventory gains side, at the end.
--
-- The first time this runs it also moves every Fleet Services
-- item (name containing "Fleet Service") to side inventory and
-- blanks its reorder point. Running it again leaves items as
-- they are, so changes made in the app afterwards are kept.
--
-- Run before pushing the page that goes with it. Safe to re-run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. The side flag, a reorder point that can be blank, and the
--    Fleet Services move (first run only)
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'apparel' and table_name = 'items' and column_name = 'side') then
    alter table apparel.items add column side boolean not null default false;
    alter table apparel.items alter column reorder_threshold drop not null;

    update apparel.items
    set side = true, reorder_threshold = null
    where name ilike '%fleet service%' and not is_test;
  end if;
end;
$$;

alter table apparel.items alter column reorder_threshold drop not null;

-- ------------------------------------------------------------
-- 2. The view the page reads: as in 20261123120000_overflow.sql,
--    with refill never null and side added on the end.
-- ------------------------------------------------------------
create or replace view apparel.inventory as
  select a.*,
         greatest(least(coalesce(m.qty, 0), a.on_hand), 0)::integer                as overflow,
         (a.on_hand - greatest(least(coalesce(m.qty, 0), a.on_hand), 0))::integer  as on_rack,
         coalesce(greatest(least(coalesce(m.qty, 0), a.on_hand), 0) > 0
           and a.on_hand - greatest(least(coalesce(m.qty, 0), a.on_hand), 0) <= a.reorder_threshold, false) as refill,
         i.overflow_location,
         i.side
  from apparel.inventory_all a
  join apparel.items i on i.id = a.id
  left join (select item_id, sum(qty) as qty from apparel.overflow_moves group by item_id) m on m.item_id = a.id
  where apparel.is_member();
revoke all on apparel.inventory from public, anon, authenticated;
grant select on apparel.inventory to authenticated;

commit;

notify pgrst, 'reload schema';

-- Shown under Results: the items now in side inventory, with
-- their reorder points (blank means order as needed).
select name, color, size, sku, reorder_threshold, active
from apparel.items
where side
order by name, color nulls first, size;
