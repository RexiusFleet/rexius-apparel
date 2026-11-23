-- ============================================================
-- Overflow: extra stock kept in boxes, off the rack.
--
-- An item's stock is still one number, the sum of its
-- transactions. Overflow is a second number beside it: how many
-- of those are boxed up in the overflow area. What's on the rack
-- is the difference. Moving stock between the two is not a
-- receive, a check out or an adjustment, so costs, chargeback
-- reports and coding reports are untouched.
--
--   * apparel.overflow_moves: one row per move. qty is positive
--     for rack -> overflow and negative for overflow -> rack. An
--     item's overflow is the sum of its rows.
--   * apparel.items.overflow_location: optional note on where the
--     box is ("Box 3, top shelf").
--   * apparel.move_overflow(): the only way a move is recorded.
--     Admins only. Refuses to move more than is there.
--   * apparel.inventory gains overflow, on_rack, refill and
--     overflow_location. on_hand and low_stock are unchanged:
--     they still count everything, rack and overflow together.
--     refill is true when the rack is at or below the reorder
--     point and there is overflow to bring over.
--   * Low-stock emails: a stock change that takes the RACK to the
--     reorder point while overflow still has some queues a
--     'refill' alert instead ("bring more over"). The total
--     reaching the reorder point still queues a 'low' alert
--     ("reorder"), as before. Moving stock into overflow never
--     emails.
--   * If stock ever drops below the overflow figure (someone took
--     from a box, or a count was adjusted down), overflow is cut
--     to match, with a row saying so.
--
-- Run before deploying low-stock-alert and pushing the page that
-- go with it. Safe to re-run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. The moves, and where the box is
-- ------------------------------------------------------------
create table if not exists apparel.overflow_moves (
  id          bigint generated always as identity primary key,
  item_id     uuid not null references apparel.items(id) on delete cascade,
  qty         integer not null check (qty <> 0),   -- + into overflow, - back to the rack
  note        text,
  moved_by    uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists overflow_moves_item_idx on apparel.overflow_moves (item_id);

alter table apparel.items add column if not exists overflow_location text;

alter table apparel.overflow_moves enable row level security;

-- Admins read the history, and delete it for test items (Clear test
-- activity). Rows are only added through apparel.move_overflow().
drop policy if exists "admins_select" on apparel.overflow_moves;
drop policy if exists "admins_delete" on apparel.overflow_moves;
create policy "admins_select" on apparel.overflow_moves for select to authenticated using (apparel.is_admin());
create policy "admins_delete" on apparel.overflow_moves for delete to authenticated using (apparel.is_admin());

revoke all on apparel.overflow_moves from anon, authenticated;
grant select, delete on apparel.overflow_moves to authenticated;
grant all on apparel.overflow_moves to service_role;

-- ------------------------------------------------------------
-- 2. Record a move (admins only)
--
--    p_qty > 0 moves that many from the rack to overflow, < 0
--    brings them back, 0 only saves the location note. The
--    location is cleared when overflow reaches 0.
-- ------------------------------------------------------------
create or replace function apparel.move_overflow(p_item_id uuid, p_qty integer, p_location text default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = apparel, pg_temp
as $$
declare
  v_on_hand  integer;
  v_raw      integer;
  v_overflow integer;
  v_new      integer;
begin
  if not apparel.is_admin() then
    raise exception 'Only admins can move stock to or from overflow.';
  end if;
  if p_qty is null then
    raise exception 'Enter how many to move.';
  end if;
  if not exists (select 1 from apparel.items where id = p_item_id) then
    raise exception 'That item no longer exists.';
  end if;

  -- The same lock the low-stock trigger takes, so a check out and a
  -- move on the same item go one at a time.
  perform pg_advisory_xact_lock(hashtext('apparel.low_stock_alerts'), hashtext(p_item_id::text));

  select coalesce(sum(qty_change), 0)::integer into v_on_hand from apparel.transactions where item_id = p_item_id;
  select coalesce(sum(qty), 0)::integer into v_raw from apparel.overflow_moves where item_id = p_item_id;
  v_overflow := greatest(least(v_raw, v_on_hand), 0);
  if v_raw <> v_overflow then
    insert into apparel.overflow_moves (item_id, qty, note, moved_by)
    values (p_item_id, v_overflow - v_raw, 'Automatic: overflow cut to match the stock count', auth.uid());
  end if;

  v_new := v_overflow + p_qty;
  if v_new < 0 then
    raise exception 'Only % in overflow to bring back.', v_overflow;
  end if;
  if v_new > v_on_hand then
    raise exception 'Only % on the rack to move.', v_on_hand - v_overflow;
  end if;

  if p_qty <> 0 then
    insert into apparel.overflow_moves (item_id, qty, note, moved_by)
    values (p_item_id, p_qty, nullif(trim(p_note), ''), auth.uid());
  end if;

  update apparel.items
  set overflow_location = case when v_new > 0 then nullif(trim(p_location), '') end
  where id = p_item_id;

  return jsonb_build_object('on_hand', v_on_hand, 'overflow', v_new, 'on_rack', v_on_hand - v_new);
end;
$$;

revoke all on function apparel.move_overflow(uuid, integer, text, text) from public, anon;
grant execute on function apparel.move_overflow(uuid, integer, text, text) to authenticated;

-- ------------------------------------------------------------
-- 3. The view the page reads, with the overflow numbers added
--
--    apparel.inventory_all (every item's on_hand and low_stock) is
--    left as it is. The new columns go on the end, so nothing that
--    already reads this view changes.
-- ------------------------------------------------------------
create or replace view apparel.inventory as
  select a.*,
         greatest(least(coalesce(m.qty, 0), a.on_hand), 0)::integer                as overflow,
         (a.on_hand - greatest(least(coalesce(m.qty, 0), a.on_hand), 0))::integer  as on_rack,
         (greatest(least(coalesce(m.qty, 0), a.on_hand), 0) > 0
           and a.on_hand - greatest(least(coalesce(m.qty, 0), a.on_hand), 0) <= a.reorder_threshold) as refill,
         i.overflow_location
  from apparel.inventory_all a
  join apparel.items i on i.id = a.id
  left join (select item_id, sum(qty) as qty from apparel.overflow_moves group by item_id) m on m.item_id = a.id
  where apparel.is_member();
revoke all on apparel.inventory from public, anon, authenticated;
grant select on apparel.inventory to authenticated;

-- ------------------------------------------------------------
-- 4. Alerts: what kind, and how much was in overflow
-- ------------------------------------------------------------
alter table apparel.low_stock_alerts add column if not exists kind text not null default 'low';
alter table apparel.low_stock_alerts add column if not exists overflow integer not null default 0;
alter table apparel.low_stock_alerts drop constraint if exists low_stock_alerts_kind_check;
alter table apparel.low_stock_alerts add constraint low_stock_alerts_kind_check check (kind in ('low', 'refill'));

-- Same as before (20261102210000_low_stock_alerts.sql), plus the
-- refill alert and cutting overflow back when stock drops below it.
create or replace function apparel.queue_low_stock_alerts()
returns trigger
language plpgsql
security definer
set search_path = apparel, pg_temp
as $$
declare
  v_items   uuid[];      -- items this statement took stock away from
  v_changes integer[];   -- and by how much (negative), in the same order
  v_key     integer;
  v_queued  integer := 0;
begin
  begin
    -- Net change per item in this statement. Only items that went down can cross.
    if tg_op = 'INSERT' then
      select array_agg(c.item_id order by c.item_id), array_agg(c.change order by c.item_id)
        into v_items, v_changes
      from (select item_id, sum(qty_change)::integer as change from new_rows group by item_id) c
      where c.change < 0;
    elsif tg_op = 'UPDATE' then
      select array_agg(c.item_id order by c.item_id), array_agg(c.change order by c.item_id)
        into v_items, v_changes
      from (
        select u.item_id, sum(u.qty)::integer as change
        from (select item_id, qty_change as qty from new_rows
              union all
              select item_id, -qty_change from old_rows) u
        group by u.item_id
      ) c
      where c.change < 0;
    else
      -- DELETE: removing a receipt takes its stock back out. Deleting
      -- test rows (Clear test activity) never emails.
      select array_agg(c.item_id order by c.item_id), array_agg(c.change order by c.item_id)
        into v_items, v_changes
      from (select item_id, -sum(qty_change)::integer as change from old_rows group by item_id) c
      join apparel.items i on i.id = c.item_id
      where c.change < 0 and not i.is_test;
    end if;

    if v_items is null then
      return null;
    end if;

    -- One stock change at a time per item from here to the end of the
    -- transaction, so two check outs at the same moment can't both miss
    -- the crossing or both report it. Advisory locks rather than row
    -- locks, which could deadlock with the item row locks taken by the
    -- foreign key checks and by the cost trigger on receive.
    for v_key in
      select distinct hashtext(u.item_id::text) from unnest(v_items) as u(item_id) order by 1
    loop
      perform pg_advisory_xact_lock(hashtext('apparel.low_stock_alerts'), v_key);
    end loop;

    -- 'low':    everything (rack and overflow) is at the reorder point now, and wasn't before.
    -- 'refill': the rack is at the reorder point now and wasn't before, and overflow has some.
    insert into apparel.low_stock_alerts (item_id, on_hand, reorder_threshold, is_test, triggered_by, kind, overflow)
    select x.id, x.on_hand, x.reorder_threshold, x.is_test, auth.uid(),
           case when x.on_hand <= x.reorder_threshold then 'low' else 'refill' end, x.overflow
    from (
      select i.id, i.reorder_threshold, i.is_test, s.on_hand, c.change, o.raw,
             greatest(least(o.raw, s.on_hand), 0) as overflow
      from unnest(v_items, v_changes) as c(item_id, change)
      join apparel.items i on i.id = c.item_id
      cross join lateral (
        select coalesce(sum(t.qty_change), 0)::integer as on_hand
        from apparel.transactions t
        where t.item_id = i.id
      ) s
      cross join lateral (
        select coalesce(sum(m.qty), 0)::integer as raw
        from apparel.overflow_moves m
        where m.item_id = i.id
      ) o
      where i.active
    ) x
    where (x.on_hand <= x.reorder_threshold and x.on_hand - x.change > x.reorder_threshold)
       or (x.on_hand > x.reorder_threshold
           and x.overflow > 0
           and x.on_hand - x.overflow <= x.reorder_threshold
           and x.on_hand - x.change - x.raw > x.reorder_threshold);
    get diagnostics v_queued = row_count;

    -- Stock fell below what overflow was said to hold: cut overflow to match.
    begin
      insert into apparel.overflow_moves (item_id, qty, note, moved_by)
      select c.item_id, greatest(s.on_hand, 0) - o.raw, 'Automatic: stock dropped below the overflow count', auth.uid()
      from unnest(v_items) as c(item_id)
      cross join lateral (
        select coalesce(sum(t.qty_change), 0)::integer as on_hand
        from apparel.transactions t
        where t.item_id = c.item_id
      ) s
      cross join lateral (
        select coalesce(sum(m.qty), 0)::integer as raw
        from apparel.overflow_moves m
        where m.item_id = c.item_id
      ) o
      where o.raw > greatest(s.on_hand, 0);
    exception when others then
      raise warning 'Overflow count not corrected: %', sqlerrm;
    end;

    if v_queued > 0 then
      begin
        perform net.http_post(
          url := 'https://hibjqcgitqtgmkurghlw.supabase.co/functions/v1/low-stock-alert',
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        );
      exception when others then
        raise warning 'Low-stock alert queued, but the email function could not be called: %', sqlerrm;
      end;
    end if;
  exception when others then
    raise warning 'Low-stock alert check skipped: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function apparel.queue_low_stock_alerts() from public, anon, authenticated;

-- The Edge Function's claim, now also returning kind and overflow.
-- Dropped first because its list of returned columns changes.
drop function if exists apparel.claim_low_stock_alerts();
create function apparel.claim_low_stock_alerts()
returns table (
  id bigint, item_id uuid, name text, size text, sku text,
  on_hand integer, reorder_threshold integer, is_test boolean,
  triggered_by uuid, created_at timestamptz, kind text, overflow integer
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
    returning a.id, a.item_id, a.on_hand, a.reorder_threshold, a.is_test, a.triggered_by, a.created_at, a.kind, a.overflow
  )
  select c.id, c.item_id,
         i.name || coalesce(' – ' || nullif(trim(i.color), ''), ''),
         i.size, i.sku, c.on_hand, c.reorder_threshold, c.is_test, c.triggered_by, c.created_at, c.kind, c.overflow
  from claimed c
  join apparel.items i on i.id = c.item_id
  order by i.name, i.color nulls first, i.size;
$$;

revoke all on function apparel.claim_low_stock_alerts() from public, anon, authenticated;
grant execute on function apparel.claim_low_stock_alerts() to service_role;

commit;

notify pgrst, 'reload schema';

-- Check (optional, run separately). Should give one row: 0, true.
-- select (select count(*) from apparel.overflow_moves) as moves,
--        exists (select 1 from information_schema.columns
--                where table_schema = 'apparel' and table_name = 'inventory' and column_name = 'on_rack') as view_updated;
