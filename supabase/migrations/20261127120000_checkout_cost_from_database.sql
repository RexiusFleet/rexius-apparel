-- ============================================================
-- The database sets a check out's cost and time.
--
-- Until now a check out was charged at whatever cost the request
-- carried, and the database only filled one in when it was blank.
-- The page no longer sends a cost, but anyone signed in could
-- still send their own straight to the database, along with their
-- own date. Now, for every check out recorded by a signed-in
-- person (checkout users and admins alike):
--
--   * unit_cost is always the item's cost at that moment,
--     whatever was sent.
--   * created_at is always the moment it was recorded.
--   * report_id and invoice_id start empty. A check out goes on a
--     coding report later, through apparel.coding_report(), and
--     never belongs to a vendor document.
--
-- Unchanged:
--   * A receive that carries a cost still sets the item's cost.
--   * Receives and adjustments keep what they are given.
--   * Rows added in the SQL Editor (no login) keep what they are
--     given, and a check out with no cost still gets the item's,
--     so one-off scripts and corrections work as before.
--   * Admins can still edit a check out afterwards (who it's for,
--     its department and notes) under the existing rules.
--
-- Only the function is replaced; the tx_cost_handling trigger on
-- apparel.transactions already calls it. Nothing to deploy and
-- nothing to push for it to take effect. Safe to re-run.
-- ============================================================

begin;

create or replace function apparel.tx_cost_handling()
returns trigger language plpgsql security definer
set search_path = apparel, pg_temp
as $$
begin
  if new.type = 'checkout' then
    if auth.uid() is not null then
      -- A signed-in person: the database decides, not the request.
      new.unit_cost  := (select unit_cost from apparel.items where id = new.item_id);
      new.created_at := now();
      new.report_id  := null;
      new.invoice_id := null;
    elsif new.unit_cost is null then
      -- The SQL Editor: fill in a missing cost, as before.
      select unit_cost into new.unit_cost from apparel.items where id = new.item_id;
    end if;
  end if;
  if new.type = 'receive' and new.unit_cost is not null then
    update apparel.items set unit_cost = new.unit_cost where id = new.item_id;
  end if;
  return new;
end;
$$;

revoke all on function apparel.tx_cost_handling() from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';

-- Check (optional, run separately). Should give one row: true.
-- select prosrc like '%auth.uid() is not null%' as updated
--   from pg_proc where oid = 'apparel.tx_cost_handling()'::regprocedure;
