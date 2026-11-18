-- ============================================================
-- Admins can record a check out for someone else.
--
-- performed_by is the person a check out is for ("Checked out
-- by"). Until now it always had to be the person signed in. Now:
--   * Admins may record any transaction for any user, so a check
--     out someone phoned in, or forgot, lands on the right person.
--   * Everyone else may still only record check outs as themselves.
--   * apparel.transactions.entered_by records who actually entered
--     each row. It is set from the login on insert, whatever the
--     page sends, and never changes afterwards, so an admin fixing
--     a check out later (who it's for, its department or notes)
--     can't hide who entered it. Rows from before this file have
--     none; the app treats that as entered by the person it's for.
--
-- Run before pushing the page that goes with it. Safe to re-run.
-- ============================================================

begin;

alter table apparel.transactions
  add column if not exists entered_by uuid references auth.users(id) on delete set null;

create or replace function apparel.tx_entered_by()
returns trigger language plpgsql
set search_path = apparel, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.entered_by := coalesce(auth.uid(), new.entered_by);   -- the SQL Editor has no login, so it keeps what it is given
  else
    new.entered_by := old.entered_by;
  end if;
  return new;
end;
$$;

drop trigger if exists tx_entered_by on apparel.transactions;
create trigger tx_entered_by
before insert or update on apparel.transactions
for each row execute function apparel.tx_entered_by();

-- Same as before, except admins may name anyone in performed_by.
drop policy if exists "members_insert" on apparel.transactions;
create policy "members_insert" on apparel.transactions for insert to authenticated
  with check (
    apparel.is_member()
    and (performed_by = auth.uid() or apparel.is_admin())
    and (type = 'checkout' or apparel.is_admin())
  );

commit;

notify pgrst, 'reload schema';

-- Check (run separately after commit):
-- select (select count(*) from information_schema.columns
--          where table_schema = 'apparel' and table_name = 'transactions' and column_name = 'entered_by') as entered_by_column,
--        (select count(*) from pg_trigger where tgname = 'tx_entered_by') as entered_by_trigger;
--   -> entered_by_column 1 | entered_by_trigger 1
