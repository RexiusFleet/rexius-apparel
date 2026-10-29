-- ============================================================
-- Starting High-Vis product list.
--
-- Built from the "High-Vis Product Info" Google Sheet
-- (one row per product with a size range) expanded to one item
-- per size, the same way the app's "Add one item per size"
-- button does it: SKU = <prefix>-<SIZE>, e.g. HV-SS-2XL.
-- One-size items (the ball cap) get size "OS" and keep the bare
-- prefix as their SKU.
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

-- The tee prefixes were shortened after the first version of this
-- script. If the old SKUs are already in the database, rename them
-- in place so their history and on-hand counts carry over.
update apparel.items set sku = replace(sku, 'HV-TS-SS-', 'HV-SS-') where sku like 'HV-TS-SS-%';
update apparel.items set sku = replace(sku, 'HV-TS-LS-', 'HV-LS-') where sku like 'HV-TS-LS-%';

-- Sized items: one row per product x size.
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
  ('HV-SS', 'High-Vis T-Shirt - Short Sleeve', 'Shirt', 15),
  ('HV-LS', 'High-Vis T-Shirt - Long Sleeve',  'Shirt', 15),
  ('HV-HD', 'High-Vis Sweatshirt',             'Hoody', 15),
  ('RX-SV', 'Safety Vest',                     'Vest',  24)
) as p(prefix, name, category, reorder_threshold)
cross join (values
  ('S'), ('M'), ('L'), ('XL'), ('2XL'), ('3XL'), ('4XL')
) as s(size)
on conflict (sku) do update
  set name              = excluded.name,
      category          = excluded.category,
      size              = excluded.size,
      reorder_threshold = excluded.reorder_threshold;

-- One-size items.
insert into apparel.items (sku, name, category, size, unit_cost, reorder_threshold, active)
values
  ('RX-BC', 'Rexius Ball Cap', 'Hat', 'OS', 0, 24, true)
on conflict (sku) do update
  set name              = excluded.name,
      category          = excluded.category,
      size              = excluded.size,
      reorder_threshold = excluded.reorder_threshold;

commit;
