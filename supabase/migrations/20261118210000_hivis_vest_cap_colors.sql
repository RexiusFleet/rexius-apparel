-- ============================================================
-- Colours for the High-Vis tees and sweatshirt, the safety vests
-- and the ball cap, plus a new set of orange safety vests.
--
--   * Anything named Hi-Vis / High-Vis (not a safety vest):
--     colour "High-Vis Yellow", HVY in the SKU, and no HV- in
--     front, since the colour code says it.
--       HV-SS-L -> SS-HVY-L
--   * Safety vests: colour Yellow, YL in the SKU, no RX- in front.
--       RX-SV-L -> SV-YL-L
--   * Rexius Ball Cap: colour Black, BL in the SKU, no RX- in front.
--       RX-BC   -> BC-BL   (its SKU has no size in it)
--   * New orange safety vests, one for every yellow one, OR in
--     the SKU (SV-OR-L). Same name, category, size, reorder
--     point and starting unit cost as the yellow vest, 0 on hand.
--     The first invoice for them sets their real cost.
--
-- The code goes in front of the size, or on the end when the SKU
-- doesn't end in the size. Only colour and SKU change on existing
-- items; stock, history, costs and vendor matches follow the item.
-- Labels already printed for these items carry the old SKU and
-- won't scan after this: reprint them (Admin -> Print labels).
-- Test items are left alone.
--
-- Safe to re-run: an item whose SKU already has its code, or that
-- already has a different colour, is left alone, and an orange
-- vest that already exists isn't added again. If an earlier
-- version of this file already ran (HV-SS-HVY-L, RX-SV-YL-L,
-- RX-SV-OR-L, RX-BC-BL), this drops their HV- and RX- too.
-- ============================================================

begin;

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('hi(gh)?[- ]?vis', 'safety vest', 'High-Vis Yellow', 'HVY'),
      ('safety vest',     null,          'Yellow',          'YL'),
      ('rexius ball cap', null,          'Black',           'BL')
    ) as v(pattern, not_pattern, color, code)
  loop
    update apparel.items
    set color = r.color,
        sku = case
                when size is not null and upper(sku) like '%-' || upper(replace(size, ' ', ''))
                  then left(sku, length(sku) - length(replace(size, ' ', ''))) || r.code || '-' || upper(replace(size, ' ', ''))
                else sku || '-' || r.code
              end
    where name ~* r.pattern
      and (r.not_pattern is null or name !~* r.not_pattern)
      and not is_test
      and (color is null or color = r.color)
      and sku !~* ('-' || r.code || '(-|$)');

    -- One whose SKU already had the code still gets the colour.
    update apparel.items set color = r.color
    where name ~* r.pattern
      and (r.not_pattern is null or name !~* r.not_pattern)
      and not is_test
      and color is null
      and sku ~* ('-' || r.code || '(-|$)');
  end loop;
end $$;

-- Drop HV- from the High-Vis Yellow items, and RX- from the vests and the cap.
update apparel.items set sku = regexp_replace(sku, '^HV-', '', 'i')
where name ~* 'hi(gh)?[- ]?vis' and name !~* 'safety vest' and not is_test
  and color = 'High-Vis Yellow' and sku ~* '^HV-';
update apparel.items set sku = regexp_replace(sku, '^RX-', '', 'i')
where ((name ~* 'safety vest' and color in ('Yellow', 'Orange')) or (name ~* 'rexius ball cap' and color = 'Black'))
  and not is_test and sku ~* '^RX-';

-- Orange safety vests: a copy of every yellow one.
insert into apparel.items (sku, name, category, color, size, unit_cost, reorder_threshold, active, is_test)
select regexp_replace(sku, '-YL(-|$)', '-OR\1', 'i'), name, category, 'Orange', size, unit_cost, reorder_threshold, active, false
from apparel.items
where name ~* 'safety vest' and color = 'Yellow' and not is_test and sku ~* '-YL(-|$)'
on conflict (sku) do nothing;

commit;

-- Shown under Results: every item this touched, with its new SKU.
select name, color, size, sku, reorder_threshold, unit_cost
from apparel.items
where not is_test and color in ('High-Vis Yellow', 'Yellow', 'Orange', 'Black')
  and (name ~* 'hi(gh)?[- ]?vis|safety vest|rexius ball cap')
order by name, color, sku;
