-- ============================================================
-- Fleet Services items are black.
--
-- Every item with "Fleet Service" in its name gets colour Black,
-- and BL (black) goes into its SKU in front of the size:
--   FS-SS-L   -> FS-SS-BL-L
--   FS-LS-2XL -> FS-LS-BL-2XL
-- A SKU that doesn't end in its size gets -BL on the end. If an
-- earlier version of this file already made them FS-SS-BLACK-L,
-- that becomes FS-SS-BL-L too.
--
-- Only the colour and SKU change. Stock, history, costs and vendor
-- matches all follow the item, not the SKU, so nothing else moves.
-- Labels already printed carry the old SKU and won't scan after
-- this: reprint them (Admin -> Print labels).
--
-- Safe to re-run: a SKU that already says BL is left alone.
-- ============================================================

begin;

-- From the earlier version of this file: BLACK -> BL.
update apparel.items
set sku = regexp_replace(sku, '-BLACK(-|$)', '-BL\1', 'i')
where name ilike '%fleet service%' and sku ~* '-BLACK(-|$)';

update apparel.items
set color = 'Black',
    sku = case
            when size is not null and upper(sku) like '%-' || upper(replace(size, ' ', ''))
              then left(sku, length(sku) - length(replace(size, ' ', ''))) || 'BL-' || upper(replace(size, ' ', ''))
            else sku || '-BL'
          end
where name ilike '%fleet service%'
  and sku !~* '-BL(-|$)';

-- Any that already said BL in the SKU still get the colour.
update apparel.items set color = 'Black'
where name ilike '%fleet service%' and color is distinct from 'Black';

commit;

-- Shown under Results: every Fleet Services item, with its new SKU.
select name, color, size, sku
from apparel.items
where name ilike '%fleet service%'
order by name, sku;
