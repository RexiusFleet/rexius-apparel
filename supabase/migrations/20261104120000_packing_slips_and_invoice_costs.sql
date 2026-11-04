-- ============================================================
-- Packing slips receive stock; invoices set costs.
--
-- What arrived and what it cost come from two different papers:
--   * A packing slip comes in the box and lists what actually
--     shipped. Reading one adds those quantities to inventory and
--     leaves costs alone.
--   * An invoice may come before or after the goods and may cover
--     several shipments. Reading one adds no stock. It sets each
--     item's current cost to the garment price plus its share of
--     the logo (decoration) charges. Set-up fees are not part of
--     item cost: they are recorded on the invoice and charged to
--     department 10 in the chargeback report.
--
-- Changes:
--   1. apparel.invoices holds every vendor document. New columns:
--      doc_type ('invoice' | 'packing_slip' | 'other'), order_no,
--      setup_fees, processed_at and processed_by. The table keeps
--      its name so existing links (transactions.invoice_id) and
--      policies stay as they are; the page calls them documents.
--   2. apparel.vendor_aliases gets color, size and design columns,
--      shown in the list of remembered matches.
--   3. apparel.cost_updates is the history of cost changes made
--      from invoices: which item, old and new cost, and the parts
--      of the new cost.
--   4. apparel.receive_packing_slip() and
--      apparel.apply_invoice_costs() do each job in one database
--      transaction, so a failure part way never leaves half a
--      packing slip received or half an invoice's costs changed.
--      Both run as the caller (security invoker), so the usual
--      admin-only row-level security still applies.
--
-- Safe to re-run: columns and tables are added once, constraints
-- and policies are dropped and recreated, functions are replaced.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Documents
-- ------------------------------------------------------------
alter table apparel.invoices add column if not exists doc_type     text not null default 'invoice';
alter table apparel.invoices add column if not exists order_no     text;
alter table apparel.invoices add column if not exists setup_fees   numeric(10,2);
alter table apparel.invoices add column if not exists processed_at timestamptz;
alter table apparel.invoices add column if not exists processed_by uuid references auth.users(id) on delete set null;

alter table apparel.invoices drop constraint if exists invoices_doc_type_check;
alter table apparel.invoices add  constraint invoices_doc_type_check check (doc_type in ('invoice', 'packing_slip', 'other'));
alter table apparel.invoices drop constraint if exists invoices_setup_fees_check;
alter table apparel.invoices add  constraint invoices_setup_fees_check check (setup_fees is null or setup_fees >= 0);

create index if not exists invoices_doc_type_idx on apparel.invoices (doc_type);
create index if not exists invoices_order_no_idx on apparel.invoices (lower(vendor), order_no) where order_no is not null;

-- ------------------------------------------------------------
-- 2. Remembered matches: what the key was built from, for display
-- ------------------------------------------------------------
alter table apparel.vendor_aliases add column if not exists color  text;
alter table apparel.vendor_aliases add column if not exists size   text;
alter table apparel.vendor_aliases add column if not exists design text;

-- ------------------------------------------------------------
-- 3. Cost history from invoices
-- ------------------------------------------------------------
create table if not exists apparel.cost_updates (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid references apparel.invoices(id) on delete set null,
  item_id       uuid not null references apparel.items(id) on delete cascade,
  qty           integer,               -- pieces billed on the invoice
  invoice_price numeric(10,2),         -- garment price per piece as billed
  decoration    numeric(10,3),         -- logo charges per piece added to it
  old_cost      numeric(10,2),
  new_cost      numeric(10,2) not null check (new_cost >= 0),
  description   text,                  -- the invoice line, for reference
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists cost_updates_item_idx    on apparel.cost_updates (item_id, created_at desc);
create index if not exists cost_updates_invoice_idx on apparel.cost_updates (invoice_id);

alter table apparel.cost_updates enable row level security;

drop policy if exists "admins_select" on apparel.cost_updates;
drop policy if exists "admins_insert" on apparel.cost_updates;
drop policy if exists "admins_delete" on apparel.cost_updates;
create policy "admins_select" on apparel.cost_updates for select to authenticated using (apparel.is_admin());
create policy "admins_insert" on apparel.cost_updates for insert to authenticated with check (apparel.is_admin());
create policy "admins_delete" on apparel.cost_updates for delete to authenticated using (apparel.is_admin());

revoke all on apparel.cost_updates from anon;
grant select, insert, delete on apparel.cost_updates to authenticated;
grant all on apparel.cost_updates to service_role;

-- ------------------------------------------------------------
-- 4a. Receive a packing slip
--   p_header: { vendor, order_no, date }   date is YYYY-MM-DD or ""
--   p_lines:  [{ item_id, qty, notes }]
-- Adds one receive transaction per line, with no cost, linked to
-- the document, and marks the document as a processed packing slip.
-- Returns the number of lines received.
-- ------------------------------------------------------------
create or replace function apparel.receive_packing_slip(p_document_id uuid, p_header jsonb, p_lines jsonb)
returns integer
language plpgsql
security invoker
set search_path = apparel, pg_temp
as $$
declare
  v_count integer;
begin
  if not apparel.is_admin() then
    raise exception 'Only admins can receive stock.' using errcode = '42501';
  end if;
  perform 1 from apparel.invoices where id = p_document_id for update;
  if not found then
    raise exception 'That document doesn''t exist.';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'There is nothing to receive.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
    where nullif(l->>'item_id', '') is null
       or coalesce(l->>'qty', '') !~ '^[0-9]+$'
       or (l->>'qty')::integer < 1
  ) then
    raise exception 'Every line needs an item and a whole quantity of 1 or more.';
  end if;

  insert into apparel.transactions (type, item_id, qty_change, unit_cost, performed_by, invoice_id, notes)
  select 'receive', (l->>'item_id')::uuid, (l->>'qty')::integer, null, auth.uid(), p_document_id,
         left(nullif(trim(l->>'notes'), ''), 200)
  from jsonb_array_elements(p_lines) l;
  get diagnostics v_count = row_count;

  update apparel.invoices set
    doc_type     = 'packing_slip',
    vendor       = coalesce(nullif(trim(p_header->>'vendor'), ''), vendor),
    order_no     = nullif(trim(p_header->>'order_no'), ''),
    invoice_date = nullif(trim(p_header->>'date'), '')::date,
    processed_at = now(),
    processed_by = auth.uid()
  where id = p_document_id;

  return v_count;
end;
$$;

-- ------------------------------------------------------------
-- 4b. Apply an invoice's costs
--   p_header: { vendor, invoice_no, date, total, setup_fees }
--   p_lines:  [{ item_id, qty, invoice_price, decoration, new_cost, description }]
-- Sets each item's unit_cost to new_cost, records the change in
-- cost_updates, and marks the document as a processed invoice with
-- its set-up fees. An item may appear only once (the page combines
-- repeated items first). No lines is allowed, for an invoice that
-- only carries set-up fees. Returns the number of items updated.
-- ------------------------------------------------------------
create or replace function apparel.apply_invoice_costs(p_document_id uuid, p_header jsonb, p_lines jsonb)
returns integer
language plpgsql
security invoker
set search_path = apparel, pg_temp
as $$
declare
  v_line  jsonb;
  v_item  uuid;
  v_old   numeric(10,2);
  v_count integer := 0;
begin
  if not apparel.is_admin() then
    raise exception 'Only admins can update costs.' using errcode = '42501';
  end if;
  perform 1 from apparel.invoices where id = p_document_id for update;
  if not found then
    raise exception 'That document doesn''t exist.';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Lines must be a list.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
    where nullif(l->>'item_id', '') is null
       or coalesce(l->>'new_cost', '') !~ '^[0-9]+(\.[0-9]+)?$'
  ) then
    raise exception 'Every line needs an item and a cost of 0 or more.';
  end if;
  if (select count(*) from jsonb_array_elements(p_lines)) <> (select count(distinct l->>'item_id') from jsonb_array_elements(p_lines) l) then
    raise exception 'An item appears on more than one line. Combine them first.';
  end if;
  if coalesce(nullif(trim(p_header->>'setup_fees'), ''), '0') !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception 'Set-up fees must be 0 or more.';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_item := (v_line->>'item_id')::uuid;
    select unit_cost into v_old from apparel.items where id = v_item for update;
    if not found then
      raise exception 'One of the items no longer exists. Reload the page and try again.';
    end if;
    update apparel.items set unit_cost = (v_line->>'new_cost')::numeric where id = v_item;
    insert into apparel.cost_updates (invoice_id, item_id, qty, invoice_price, decoration, old_cost, new_cost, description, created_by)
    values (
      p_document_id, v_item,
      nullif(v_line->>'qty', '')::numeric::integer,
      nullif(v_line->>'invoice_price', '')::numeric,
      nullif(v_line->>'decoration', '')::numeric,
      v_old,
      (v_line->>'new_cost')::numeric,
      left(nullif(trim(v_line->>'description'), ''), 200),
      auth.uid()
    );
    v_count := v_count + 1;
  end loop;

  update apparel.invoices set
    doc_type     = 'invoice',
    vendor       = coalesce(nullif(trim(p_header->>'vendor'), ''), vendor),
    invoice_no   = nullif(trim(p_header->>'invoice_no'), ''),
    invoice_date = nullif(trim(p_header->>'date'), '')::date,
    total        = nullif(trim(p_header->>'total'), '')::numeric,
    setup_fees   = coalesce(nullif(trim(p_header->>'setup_fees'), '')::numeric, 0),
    processed_at = now(),
    processed_by = auth.uid()
  where id = p_document_id;

  return v_count;
end;
$$;

revoke all on function apparel.receive_packing_slip(uuid, jsonb, jsonb) from public, anon;
revoke all on function apparel.apply_invoice_costs(uuid, jsonb, jsonb)  from public, anon;
grant execute on function apparel.receive_packing_slip(uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function apparel.apply_invoice_costs(uuid, jsonb, jsonb)  to authenticated, service_role;

commit;

notify pgrst, 'reload schema';

-- Check (run separately after commit):
-- select column_name from information_schema.columns
--  where table_schema = 'apparel' and table_name = 'invoices'
--    and column_name in ('doc_type', 'order_no', 'setup_fees', 'processed_at', 'processed_by');
--   -> 5 rows
-- select to_regclass('apparel.cost_updates');                    -> apparel.cost_updates
-- select to_regprocedure('apparel.receive_packing_slip(uuid,jsonb,jsonb)'),
--        to_regprocedure('apparel.apply_invoice_costs(uuid,jsonb,jsonb)');   -> both non-null
