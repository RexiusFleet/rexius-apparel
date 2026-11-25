-- ============================================================
-- Stock count: every safety vest set to 50 on hand.
--
-- Every active, real safety vest (Yellow and Orange, every size)
-- gets an Adjust for the difference between its count now and 50,
-- exactly as if the Adjust button had been used on each one. A
-- vest already at 50 is left alone. Each adjustment is recorded
-- as yours, with the reason "Stock count: safety vests set to 50
-- (2026-11-25)", so it shows in Recent activity and can be undone
-- there one by one.
--
-- 50 is the whole count, rack and overflow together, like the
-- On hand number. Adjustments never change costs, chargeback
-- reports or coding reports, and raising a count never sends a
-- low-stock email.
--
-- BEFORE RUNNING: put the email you sign in to the app with on the
-- v_email line below. If it isn't an active admin's login, nothing
-- changes and the error says so.
--
-- Safe to re-run: once these adjustments exist it does nothing,
-- so later check outs are never wiped out by running it again.
-- ============================================================

begin;

do $$
declare
  v_email text := 'your-login@example.com';   -- <<< your app sign-in email goes here
  v_note  text := 'Stock count: safety vests set to 50 (2026-11-25)';
  v_user  uuid;
begin
  if exists (select 1 from apparel.transactions where notes = v_note) then
    raise notice 'Already done earlier: nothing changed.';
    return;
  end if;

  select id into v_user from auth.users where lower(email) = lower(trim(v_email));
  if v_user is null then
    raise exception 'No login with the email "%". Put the email you sign in to the app with on the v_email line near the top, then run it again. Nothing was changed.', v_email;
  end if;
  if not exists (select 1 from apparel.app_users where user_id = v_user and active and role = 'admin') then
    raise exception '"%" isn''t an active admin in the app. Nothing was changed.', v_email;
  end if;

  -- One statement, so the low-stock check runs once for all of them.
  insert into apparel.transactions (type, item_id, qty_change, performed_by, entered_by, notes)
  select 'adjust', s.id, 50 - s.on_hand, v_user, v_user, v_note
  from (
    select i.id, coalesce(sum(t.qty_change), 0)::integer as on_hand
    from apparel.items i
    left join apparel.transactions t on t.item_id = i.id
    where i.name ~* 'safety vest' and i.active and not i.is_test
    group by i.id
  ) s
  where s.on_hand <> 50;
end;
$$;

commit;

-- Shown under Results: every safety vest and its count now.
-- on_hand should be 50 on every row.
select i.name, i.color, i.size, i.sku,
       coalesce(t.on_hand, 0) as on_hand,
       greatest(least(coalesce(m.qty, 0), coalesce(t.on_hand, 0)), 0) as in_overflow
from apparel.items i
left join (select item_id, sum(qty_change)::integer as on_hand from apparel.transactions group by item_id) t on t.item_id = i.id
left join (select item_id, sum(qty)::integer as qty from apparel.overflow_moves group by item_id) m on m.item_id = i.id
where i.name ~* 'safety vest' and i.active and not i.is_test
order by i.color,
         coalesce(array_position(array['XS','S','M','L','XL','2XL','3XL','4XL','5XL'], upper(i.size)), 99),
         i.size;
