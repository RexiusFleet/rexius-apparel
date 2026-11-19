-- ============================================================
-- Checkout users read only their own check outs.
--
-- Until now every app user could read every stock change. Now:
--   * Admins still read every transaction.
--   * Checkout users read only check outs recorded as theirs
--     (performed_by is them), not anyone else's, and no receives
--     or adjustments.
--
-- On-hand counts still need every transaction. apparel.inventory
-- used to run as the person asking (security_invoker), so with
-- this rule it would only add up a checkout user's own check
-- outs. So the existing view is kept, unchanged, as
-- apparel.inventory_all, which runs as its owner and nobody can
-- read directly, and apparel.inventory becomes a thin view over
-- it that returns rows only to active app users. The page keeps
-- reading apparel.inventory exactly as before.
--
-- Nothing else changes: the low-stock trigger runs as its owner,
-- and reports and coding reports are admin-only already.
--
-- Run before pushing the page that goes with it. Safe to re-run.
-- ============================================================

begin;

-- 1. Transactions: admins read all, checkout users their own check outs.
drop policy if exists "members_select" on apparel.transactions;
drop policy if exists "admins_select"  on apparel.transactions;
drop policy if exists "own_checkouts_select" on apparel.transactions;
create policy "admins_select" on apparel.transactions for select to authenticated
  using (apparel.is_admin());
create policy "own_checkouts_select" on apparel.transactions for select to authenticated
  using (apparel.is_member() and type = 'checkout' and performed_by = auth.uid());

-- 2. Keep the existing inventory view as inventory_all (first run only).
do $$
begin
  if to_regclass('apparel.inventory_all') is null then
    alter view apparel.inventory rename to inventory_all;
  end if;
end $$;

alter view apparel.inventory_all set (security_invoker = false);   -- counts every transaction
revoke all on apparel.inventory_all from public, anon, authenticated;

-- 3. The view the page reads: every count, but only for active app users.
create or replace view apparel.inventory as
  select * from apparel.inventory_all where apparel.is_member();
revoke all on apparel.inventory from public, anon, authenticated;   -- drops the schema's default write grants
grant select on apparel.inventory to authenticated;

commit;

notify pgrst, 'reload schema';

-- Check (optional): run these two lines. The first should say
-- false and the second true.
-- select relname, coalesce('security_invoker=true' = any(reloptions), false) as runs_as_reader
--   from pg_class where oid = 'apparel.inventory_all'::regclass;
-- select count(*) > 0 as has_rows from apparel.inventory_all;
