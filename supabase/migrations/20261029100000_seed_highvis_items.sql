-- ============================================================
-- Starting High-Vis product list.
--
-- Built from the "High-Vis Product Info" Google Sheet
-- (one row per product with a size range) expanded to one item
-- per size, the same way the app's "Add sizes" button does it:
-- SKU = <prefix>-<SIZE>, e.g. HV-TS-SS-2XL.
--
-- Unit cost is left at 0 on purpose: the receive and invoice
-- flows update it from the latest invoice line, so it will track
-- real purchase prices as they come in.
--
-- Safe to re-run: an existing SKU gets its name, category, size
-- and reorder threshold refreshed, but its unit cost and
-- active flag are left alone (those are maintained in the app).
-- ============================================================

begin;

insert into apparel.items (sku, name, category, size, unit_cost, reorder_threshold, active)
select
  prefix || '-' || size,
  name,
  category,
  size,
  0,
  reorder_threshold,
  true
from (values
  ('HV-TS-SS', 'High-Vis T-Shirt - Short Sleeve', 'Shirt', 10),
  ('HV-TS-LS', 'High-Vis T-Shirt - Long Sleeve',  'Shirt', 10),
  ('HV-HD',    'High-Vis Sweatshirt',             'Hoody', 10)
) as p(prefix, name, category, reorder_threshold)
cross join (values
  ('S'), ('M'), ('L'), ('XL'), ('2XL'), ('3XL'), ('4XL')
) as s(size)
on conflict (sku) do update
  set name              = excluded.name,
      category          = excluded.category,
      size              = excluded.size,
      reorder_threshold = excluded.reorder_threshold;

commit;
