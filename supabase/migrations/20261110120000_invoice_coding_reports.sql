-- ============================================================
-- Invoice coding reports.
--
-- Stock is bought ahead and invoiced as it arrives; departments
-- are charged later, as items are checked out. So each invoice is
-- "coded" with the department charges made since the last one:
--
--   1. The invoice's set-up fees go to department 10.
--   2. Check outs not yet on a report fill the rest, oldest first,
--      whole check outs only.
--   3. If they don't fill it, what is left is Stock Up.
--   4. If there are more than fit, the rest carry over to the next
--      invoice, and the small gap left by the last one that fits
--      goes to department 10.
--
-- The lines always add up to the invoice total, and every check
-- out lands on exactly one report.
--
-- Changes:
--   * apparel.coding_reports: one row per invoice, with the totals
--     as they were when the report was saved.
--   * apparel.transactions.report_id: which report a check out is
--     on. Deleting a report (or its invoice) frees its check outs
--     for the next one.
--   * apparel.coding_report(invoice, save): returns the report as
--     JSON. With save = false it is a preview and changes nothing;
--     with save = true it stores the report and claims the check
--     outs in one transaction. Once saved, it always returns the
--     saved report. Runs as the caller, so admin-only row-level
--     security still applies.
--
-- Safe to re-run.
-- ============================================================

begin;

create table if not exists apparel.coding_reports (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null unique references apparel.invoices(id) on delete cascade,
  invoice_total numeric(10,2) not null,
  setup_fees    numeric(10,2) not null default 0,   -- to department 10
  charges_total numeric(10,2) not null default 0,   -- check outs on this report
  gap           numeric(10,2) not null default 0,   -- to department 10, only when check outs carried over
  stock_up      numeric(10,2) not null default 0,   -- only when nothing carried over
  carried_count integer       not null default 0,   -- check outs left for the next invoice
  carried_total numeric(10,2) not null default 0,
  is_test       boolean       not null default false,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz   not null default now()
);

alter table apparel.coding_reports enable row level security;

drop policy if exists "admins_select" on apparel.coding_reports;
drop policy if exists "admins_insert" on apparel.coding_reports;
drop policy if exists "admins_delete" on apparel.coding_reports;
create policy "admins_select" on apparel.coding_reports for select to authenticated using (apparel.is_admin());
create policy "admins_insert" on apparel.coding_reports for insert to authenticated with check (apparel.is_admin());
create policy "admins_delete" on apparel.coding_reports for delete to authenticated using (apparel.is_admin());

revoke all on apparel.coding_reports from anon;
grant select, insert, delete on apparel.coding_reports to authenticated;
grant all on apparel.coding_reports to service_role;

alter table apparel.transactions
  add column if not exists report_id uuid references apparel.coding_reports(id) on delete set null;
create index if not exists transactions_report_id_idx on apparel.transactions (report_id);
-- Finding the check outs still waiting for a report.
create index if not exists transactions_unreported_idx on apparel.transactions (created_at) where type = 'checkout' and report_id is null;

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
           'employee', e.full_name, 'item', i.name, 'size', i.size, 'sku', i.sku,
           'qty', -t.qty_change, 'unit_cost', coalesce(t.unit_cost, 0),
           'amount', round(-t.qty_change * coalesce(t.unit_cost, 0), 2)
         ) order by t.created_at, t.id), '[]'::jsonb)
    into v_lines
  from apparel.transactions t
  join apparel.items i on i.id = t.item_id
  left join apparel.departments d on d.id = t.department_id
  left join apparel.employees e on e.id = t.employee_id
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
-- select to_regclass('apparel.coding_reports'),
--        to_regprocedure('apparel.coding_report(uuid,boolean)'),
--        (select count(*) from information_schema.columns
--          where table_schema = 'apparel' and table_name = 'transactions' and column_name = 'report_id');
--   -> apparel.coding_reports | apparel.coding_report(uuid,boolean) | 1
