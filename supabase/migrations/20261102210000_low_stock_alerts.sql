-- ============================================================
-- Low-stock emails.
--
-- When a stock change takes an active item from above its reorder
-- point to at or below it (the moment the app starts flagging it
-- Low), the app's active admins get an email. One stock change, one
-- email: a check out that takes three items down lists all three.
-- An item that stays low doesn't email again; it has to be
-- restocked above its reorder point and drop again. Adding items,
-- editing reorder points and reactivating items never email.
--
-- How it works:
--   1. Three statement-level triggers on apparel.transactions
--      (insert, update, delete) work out how much each statement
--      took away from each item, and queue a row in
--      apparel.low_stock_alerts for every item that crossed its
--      reorder point.
--   2. When anything was queued, the trigger calls the
--      low-stock-alert Edge Function through pg_net. The request
--      goes out after the transaction commits (never if it rolls
--      back) and carries nothing: the function only sends what is
--      queued here, so a stray call can't send anything that isn't
--      due.
--   3. The function claims the due rows (claim_low_stock_alerts),
--      emails them from the app's Gmail account and records the
--      outcome on each row: sent (and to whom), failed (with the
--      error; tried again on a later call, up to 5 tries within a
--      day) or skipped.
--
-- Test items (items.is_test) email only the person who made the
-- change, marked [TEST]. Deleting test transactions (Clear test
-- activity) never emails.
--
-- A stock change never fails because of this: any error in the
-- alert step becomes a warning and the change goes ahead.
--
-- The function address below is this Supabase project's
-- (hibjqcgitqtgmkurghlw). If the app ever moves to another project,
-- change it and re-run this file.
--
-- Needs the pg_net extension; the first statement turns it on. If
-- that statement fails, turn on pg_net under Database -> Extensions
-- and run this file again. Safe to re-run.
-- ============================================================

begin;

create extension if not exists pg_net with schema extensions;

-- ------------------------------------------------------------
-- 1. The queue, which doubles as the history of low-stock emails
-- ------------------------------------------------------------
create table if not exists apparel.low_stock_alerts (
  id                 bigint generated always as identity primary key,
  item_id            uuid not null references apparel.items(id) on delete cascade,
  on_hand            integer not null,          -- stock right after the change
  reorder_threshold  integer not null,          -- the item's reorder point at the time
  is_test            boolean not null default false,
  triggered_by       uuid references auth.users(id) on delete set null,   -- who made the change
  status             text not null default 'pending'
                     check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts           integer not null default 0,
  last_attempt_at    timestamptz,
  sent_to            text,                      -- the addresses it went to
  error              text,                      -- why it failed or was skipped
  created_at         timestamptz not null default now(),
  sent_at            timestamptz
);
create index if not exists low_stock_alerts_item_idx on apparel.low_stock_alerts (item_id);

alter table apparel.low_stock_alerts enable row level security;

-- Admins can read the history. Nothing is written from the browser:
-- the triggers below and the Edge Function (service role) do that.
drop policy if exists "admins_select" on apparel.low_stock_alerts;
create policy "admins_select" on apparel.low_stock_alerts for select to authenticated using (apparel.is_admin());

-- The schema's default privileges hand authenticated insert, update
-- and delete on every new table; take them back.
revoke all on apparel.low_stock_alerts from anon, authenticated;
grant select on apparel.low_stock_alerts to authenticated;
grant all on apparel.low_stock_alerts to service_role;

-- ------------------------------------------------------------
-- 2. Queue an alert when a stock change crosses a reorder point
-- ------------------------------------------------------------
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

    insert into apparel.low_stock_alerts (item_id, on_hand, reorder_threshold, is_test, triggered_by)
    select i.id, s.on_hand, i.reorder_threshold, i.is_test, auth.uid()
    from unnest(v_items, v_changes) as c(item_id, change)
    join apparel.items i on i.id = c.item_id
    cross join lateral (
      select coalesce(sum(t.qty_change), 0)::integer as on_hand
      from apparel.transactions t
      where t.item_id = i.id
    ) s
    where i.active
      and s.on_hand <= i.reorder_threshold              -- low now
      and s.on_hand - c.change > i.reorder_threshold;   -- and it wasn't before this change
    get diagnostics v_queued = row_count;

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

-- Statement-level, so a check out of several items is looked at (and
-- emailed) as one. Postgres only allows transition tables on a trigger
-- with a single event, hence three triggers on one function.
drop trigger if exists low_stock_alerts_insert on apparel.transactions;
drop trigger if exists low_stock_alerts_update on apparel.transactions;
drop trigger if exists low_stock_alerts_delete on apparel.transactions;

create trigger low_stock_alerts_insert
  after insert on apparel.transactions
  referencing new table as new_rows
  for each statement execute function apparel.queue_low_stock_alerts();

create trigger low_stock_alerts_update
  after update on apparel.transactions
  referencing old table as old_rows new table as new_rows
  for each statement execute function apparel.queue_low_stock_alerts();

create trigger low_stock_alerts_delete
  after delete on apparel.transactions
  referencing old table as old_rows
  for each statement execute function apparel.queue_low_stock_alerts();

-- ------------------------------------------------------------
-- 3. Hand the due alerts to the Edge Function (service role only)
--
--    Marks them 'sending' in the same statement that returns them,
--    so two calls at once never send the same alert. A row is due
--    when it is pending, or failed with tries left, or stuck in
--    'sending' for 10 minutes (the function died mid-send); and it
--    is less than a day old, so a long outage doesn't end in a pile
--    of stale emails.
-- ------------------------------------------------------------
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
  select c.id, c.item_id, i.name, i.size, i.sku, c.on_hand, c.reorder_threshold, c.is_test, c.triggered_by, c.created_at
  from claimed c
  join apparel.items i on i.id = c.item_id
  order by i.name, i.size;
$$;

revoke all on function apparel.claim_low_stock_alerts() from public, anon, authenticated;
grant execute on function apparel.claim_low_stock_alerts() to service_role;

commit;

notify pgrst, 'reload schema';

-- Checks (run separately after commit):
-- select extname from pg_extension where extname = 'pg_net';
--   -> pg_net
-- select tgname from pg_trigger where tgrelid = 'apparel.transactions'::regclass and tgname like 'low_stock%' order by 1;
--   -> low_stock_alerts_delete, low_stock_alerts_insert, low_stock_alerts_update
-- select id, created_at, status, on_hand, reorder_threshold, sent_to, error from apparel.low_stock_alerts order by id desc limit 20;
--   -> no rows until the first item drops to its reorder point
