-- ============================================================
-- Check out by department, without employees.
--
-- A check out now records only the item, the quantity and the
-- department it is charged to. Who it was for is no longer asked:
-- every check out already records who did it (performed_by), and
-- that person can say who it was for if it ever matters.
--
-- Changes:
--   * apparel.app_users.department_id: each user's own department.
--     Check out fills it in on every item, and any item can be
--     switched to another department. Admins set it under
--     Admin -> Users, through the admin-users Edge Function.
--   * A check out needs a department and no longer an employee
--     (constraint checkout_needs_dept replaces
--     checkout_needs_dept_and_employee).
--   * apparel.admin_list_users() also returns each user's
--     department, for the Users screen.
--   * apparel.coding_report() lists who checked each item out
--     (checked_out_by) instead of the employee.
--   * Checkout users can no longer add employees.
--
-- Nothing is deleted. apparel.employees and the employee_id on
-- earlier check outs stay as they are; the app no longer uses them.
--
-- Order: run this first, then deploy admin-users, then push the
-- page. Safe to re-run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Each user's own department. Deleting a department clears it.
-- ------------------------------------------------------------
alter table apparel.app_users
  add column if not exists department_id uuid references apparel.departments(id) on delete set null;

-- ------------------------------------------------------------
-- 2. A check out needs a department, not an employee.
--    (The first name is the current one; the second is the
--    original, in case the rename never happened.)
-- ------------------------------------------------------------
alter table apparel.transactions drop constraint if exists checkout_needs_dept_and_employee;
alter table apparel.transactions drop constraint if exists apparel_checkout_needs_dept_and_employee;
alter table apparel.transactions drop constraint if exists checkout_needs_dept;
alter table apparel.transactions
  add constraint checkout_needs_dept check (type <> 'checkout' or department_id is not null);

-- ------------------------------------------------------------
-- 3. No new employees. Reading and the admin policies are left
--    alone, so the old rows stay as they were.
-- ------------------------------------------------------------
drop policy if exists "members_insert" on apparel.employees;

-- ------------------------------------------------------------
-- 4. The Users screen shows each user's department. The columns
--    it returns change, so the function is dropped and created.
-- ------------------------------------------------------------
drop function if exists apparel.admin_list_users();
create function apparel.admin_list_users()
returns table (
  user_id uuid, email text, display_name text, role text, active boolean,
  created_at timestamptz, last_sign_in_at timestamptz, department_id uuid
)
language sql stable security definer
set search_path = apparel, pg_temp
as $$
  select u.user_id, a.email::text, u.display_name, u.role, u.active, u.created_at, a.last_sign_in_at, u.department_id
  from apparel.app_users u
  join auth.users a on a.id = u.user_id
  order by u.active desc, lower(coalesce(u.display_name, a.email));
$$;

revoke all on function apparel.admin_list_users() from public, anon, authenticated;
grant execute on function apparel.admin_list_users() to service_role;

-- ------------------------------------------------------------
-- 5. Coding reports list who checked each item out. Everything
--    else is as in 20261110120000_invoice_coding_reports.sql.
-- ------------------------------------------------------------
create or replace function apparel.coding_report(p_invoice_id uuid, p_save boolean default false)
returns jsonb
language plpgsql
security invoker
set search_path = apparel, pg_temp
as $$
declare
  v_inv     apparel.invoices;
  v_rep     apparel.coding_reports;
  v_saved   boolean := false;
  v_avail   numeric(10,2);
  v_ids     uuid[];
  v_lines   jsonb;
begin
  if not apparel.is_admin() then
    raise exception 'Only admins can see coding reports.' using errcode = '42501';
  end if;
  select * into v_inv from apparel.invoices where id = p_invoice_id;
  if not found then
    raise exception 'That document doesn''t exist.';
  end if;

  select * into v_rep from apparel.coding_reports where invoice_id = p_invoice_id;
  if found then
    v_saved := true;
    select array_agg(id) into v_ids from apparel.transactions where report_id = v_rep.id;
  else
    if v_inv.doc_type <> 'invoice' then
      raise exception 'Only invoices get a coding report.';
    end if;
    if v_inv.total is null then
      raise exception 'Enter the invoice total first.';
    end if;
    if p_save then
      -- One report at a time, so two can't claim the same check outs.
      perform pg_advisory_xact_lock(hashtext('apparel.coding_reports'));
      select * into v_rep from apparel.coding_reports where invoice_id = p_invoice_id;
      if found then
        raise exception 'This invoice already has a coding report.';
      end if;
    end if;

    v_rep.invoice_id    := p_invoice_id;
    v_rep.invoice_total := v_inv.total;
    v_rep.setup_fees    := least(coalesce(v_inv.setup_fees, 0), v_inv.total);
    v_rep.is_test       := v_inv.is_test;
    v_avail             := v_rep.invoice_total - v_rep.setup_fees;

    -- Oldest first, whole check outs, for as long as they fit. Test invoices
    -- take test items' check outs only, and real ones never do.
    with c as (
      select t.id, t.created_at, round(-t.qty_change * coalesce(t.unit_cost, 0), 2) as amt
      from apparel.transactions t
      join apparel.items i on i.id = t.item_id
      where t.type = 'checkout' and t.report_id is null and i.is_test = v_inv.is_test
    ), r as (
      select id, amt, sum(amt) over (order by created_at, id) as run from c
    )
    select array_agg(id) filter (where run <= v_avail),
           coalesce(sum(amt) filter (where run <= v_avail), 0),
           count(*) filter (where run > v_avail),
           coalesce(sum(amt) filter (where run > v_avail), 0)
      into v_ids, v_rep.charges_total, v_rep.carried_count, v_rep.carried_total
    from r;

    if v_rep.carried_count > 0 then
      v_rep.gap := v_avail - v_rep.charges_total;  v_rep.stock_up := 0;
    else
      v_rep.gap := 0;  v_rep.stock_up := v_avail - v_rep.charges_total;
    end if;

    if p_save then
      insert into apparel.coding_reports (invoice_id, invoice_total, setup_fees, charges_total, gap, stock_up, carried_count, carried_total, is_test, created_by)
      values (p_invoice_id, v_rep.invoice_total, v_rep.setup_fees, v_rep.charges_total, v_rep.gap, v_rep.stock_up, v_rep.carried_count, v_rep.carried_total, v_rep.is_test, auth.uid())
      returning * into v_rep;
      update apparel.transactions set report_id = v_rep.id where id = any(coalesce(v_ids, '{}'::uuid[]));
      v_saved := true;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'date', t.created_at, 'dept_code', nullif(trim(d.code), ''), 'dept_name', d.name,
           'checked_out_by', u.display_name, 'item', i.name, 'size', i.size, 'sku', i.sku,
           'qty', -t.qty_change, 'unit_cost', coalesce(t.unit_cost, 0),
           'amount', round(-t.qty_change * coalesce(t.unit_cost, 0), 2)
         ) order by t.created_at, t.id), '[]'::jsonb)
    into v_lines
  from apparel.transactions t
  join apparel.items i on i.id = t.item_id
  left join apparel.departments d on d.id = t.department_id
  left join apparel.app_users u on u.user_id = t.performed_by
  where t.id = any(coalesce(v_ids, '{}'::uuid[]));

  return jsonb_build_object(
    'saved', v_saved,
    'report', jsonb_build_object(
      'id', v_rep.id, 'created_at', v_rep.created_at,
      'invoice_total', v_rep.invoice_total, 'setup_fees', v_rep.setup_fees, 'charges_total', v_rep.charges_total,
      'gap', v_rep.gap, 'stock_up', v_rep.stock_up, 'carried_count', v_rep.carried_count, 'carried_total', v_rep.carried_total,
      'is_test', v_rep.is_test),
    'invoice', jsonb_build_object('id', v_inv.id, 'vendor', v_inv.vendor, 'invoice_no', v_inv.invoice_no, 'invoice_date', v_inv.invoice_date),
    'lines', v_lines);
end;
$$;

revoke all on function apparel.coding_report(uuid, boolean) from public, anon;
grant execute on function apparel.coding_report(uuid, boolean) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';

-- Check (run separately after commit):
-- select (select count(*) from information_schema.columns
--          where table_schema = 'apparel' and table_name = 'app_users' and column_name = 'department_id') as user_department,
--        (select count(*) from pg_constraint
--          where conrelid = 'apparel.transactions'::regclass and conname = 'checkout_needs_dept') as dept_rule,
--        (select count(*) from pg_constraint
--          where conrelid = 'apparel.transactions'::regclass and conname like '%needs_dept_and_employee') as old_rule;
--   -> user_department 1 | dept_rule 1 | old_rule 0
