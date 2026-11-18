-- ============================================================
-- Item colours.
--
-- Each colour of a product is still its own item, exactly like
-- each size: its own SKU, label, count, reorder point and cost.
-- The new apparel.items.color only lets the app group them, so
-- picking an item goes product -> colour -> size, and the colour
-- shows wherever the item does.
--
--   * apparel.items.color: optional, e.g. 'Grey'. Blank for items
--     that only come in one colour.
--   * Items already named with a colour at the start or end
--     ("Black Beanie", "Beanie - Grey", "Beanie (Grey)") have it
--     moved into the new field, so they group under "Beanie".
--     Only items with no colour yet are touched, so re-running
--     never splits a name twice. The last query lists them.
--   * Low-stock emails name the colour too ("Beanie – Grey").
--
-- Run before pushing the page that goes with it. Safe to re-run.
-- ============================================================

begin;

alter table apparel.items add column if not exists color text;

-- Colour at the end: "Beanie Grey", "Beanie - Grey", "Beanie (Grey)".
update apparel.items i
set name = m.parts[1], color = initcap(m.parts[2])
from (
  select id, regexp_match(name,
    '^(.*\S)\s*[-–—(]?\s*\y(black|grey|gray|white|navy|red|blue|green|orange|yellow|lime|brown|charcoal|khaki|tan|pink|purple|maroon|camo)\)?\s*$', 'i') as parts
  from apparel.items
  where color is null
) m
where i.id = m.id and m.parts is not null and trim(m.parts[1]) not in ('', '-', '–', '—');

-- Colour at the start: "Black Beanie", "Grey - Beanie".
update apparel.items i
set name = m.parts[2], color = initcap(m.parts[1])
from (
  select id, regexp_match(name,
    '^(black|grey|gray|white|navy|red|blue|green|orange|yellow|lime|brown|charcoal|khaki|tan|pink|purple|maroon|camo)\y\s*[-–—]?\s*(\S.*)$', 'i') as parts
  from apparel.items
  where color is null
) m
where i.id = m.id and m.parts is not null;

-- Tidy any separator left at the end of a split name ("Beanie -").
update apparel.items set name = regexp_replace(name, '\s*[-–—(]\s*$', '') where color is not null and name ~ '\s*[-–—(]\s*$';

-- Low-stock emails: the item name the email uses includes the colour.
create or replace function apparel.claim_low_stock_alerts()
returns table (
  id bigint, item_id uuid, name text, size text, sku text,
  on_hand integer, reorder_threshold integer, is_test boolean,
  triggered_by uuid, created_at timestamptz
)
language sql
security definer
set search_path = apparel, pg_temp
as $$
  with due as (
    select a.id
    from apparel.low_stock_alerts a
    where a.attempts < 5
      and a.created_at > now() - interval '1 day'
      and (a.status in ('pending', 'failed')
           or (a.status = 'sending' and a.last_attempt_at < now() - interval '10 minutes'))
    order by a.id
    for update skip locked
  ), claimed as (
    update apparel.low_stock_alerts a
    set status = 'sending', attempts = a.attempts + 1, last_attempt_at = now()
    from due
    where a.id = due.id
    returning a.id, a.item_id, a.on_hand, a.reorder_threshold, a.is_test, a.triggered_by, a.created_at
  )
  select c.id, c.item_id,
         i.name || coalesce(' – ' || nullif(trim(i.color), ''), ''),
         i.size, i.sku, c.on_hand, c.reorder_threshold, c.is_test, c.triggered_by, c.created_at
  from claimed c
  join apparel.items i on i.id = c.item_id
  order by i.name, i.color nulls first, i.size;
$$;

revoke all on function apparel.claim_low_stock_alerts() from public, anon, authenticated;
grant execute on function apparel.claim_low_stock_alerts() to service_role;

commit;

notify pgrst, 'reload schema';

-- Every item that has a colour, so you can check the names look right.
select name, color, size, sku from apparel.items where color is not null order by name, color, size;
