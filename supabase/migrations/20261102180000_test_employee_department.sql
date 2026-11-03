-- ============================================================
-- Test employee and test department.
--
-- Same idea as the test product (20261102120000_test_product.sql):
-- departments and employees flagged is_test only show while an
-- admin has test mode on, and in test mode check out offers only
-- them. A test checkout then touches nothing real (test item, test
-- employee, test department), so real employees' and departments'
-- histories stay clean and test reports read as test. The Admin
-- lists show both, with a Test tag.
--
-- Adds "Test Department" (code TEST) and "Test Employee", whose
-- home department is the Test Department.
--
-- Safe to re-run: the columns are added once, and the two rows are
-- only added when they are missing.
-- ============================================================

begin;

alter table apparel.departments add column if not exists is_test boolean not null default false;
alter table apparel.employees   add column if not exists is_test boolean not null default false;

insert into apparel.departments (name, code, is_test)
values ('Test Department', 'TEST', true)
on conflict do nothing;

insert into apparel.employees (full_name, department_id, is_test)
select 'Test Employee', d.id, true
from apparel.departments d
where d.name = 'Test Department' and d.is_test
  and not exists (select 1 from apparel.employees e where e.full_name = 'Test Employee' and e.is_test);

commit;

notify pgrst, 'reload schema';

-- Check (run separately after commit):
-- select 'department' as kind, name from apparel.departments where is_test
-- union all
-- select 'employee', full_name from apparel.employees where is_test;
--   -> department | Test Department
--      employee   | Test Employee
