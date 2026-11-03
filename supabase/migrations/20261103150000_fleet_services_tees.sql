-- ============================================================
-- Fleet Services tees.
--
-- Adds the Fleet Services T-Shirt in short and long sleeve, S-4XL,
-- one item per size the same way the app's "Add one item per size"
-- button does it: SKU = <prefix>-<SIZE>, e.g. FS-SS-2XL. 14 items,
-- category Shirt like the High-Vis tees, reorder point 12.
--
-- Unit cost starts at 0; the receive and invoice flows set it from
-- the latest invoice line, as for every item. Each size shows Low
-- on the Inventory tab until more than 12 have been received.
-- Adding items never sends a low-stock email.
--
-- Safe to re-run: a SKU that is already there is left as it is.
-- ============================================================

insert into apparel.items (sku, name, category, size, unit_cost, reorder_threshold, active)
select prefix || '-' || size, name, 'Shirt', size, 0, 12, true
from (values
  ('FS-SS', 'Fleet Services T-Shirt - Short Sleeve'),
  ('FS-LS', 'Fleet Services T-Shirt - Long Sleeve')
) as p(prefix, name)
cross join (values
  ('S'), ('M'), ('L'), ('XL'), ('2XL'), ('3XL'), ('4XL')
) as s(size)
on conflict (sku) do nothing;

-- Shown under Results: the 14 Fleet Services items.
select name, size, sku, category, reorder_threshold, active
from apparel.items
where sku like 'FS-SS-%' or sku like 'FS-LS-%'
order by name, size;
