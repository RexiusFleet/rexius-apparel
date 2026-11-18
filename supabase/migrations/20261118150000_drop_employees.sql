-- ============================================================
-- Delete the employees for good.
--
-- Check outs go by department since 20261118120000_checkout_by_department.sql,
-- and the app no longer reads or writes employees. This removes
-- what was left: the employee_id on earlier check outs (with its
-- index) and the apparel.employees table, including Test Employee.
-- The check outs themselves, their departments and who did them
-- are untouched.
--
-- This can't be undone. Run it after the check-out-by-department
-- file. Safe to re-run.
-- ============================================================

begin;

alter table apparel.transactions drop column if exists employee_id;
drop table if exists apparel.employees;

commit;

notify pgrst, 'reload schema';

-- Check (run separately after commit):
-- select to_regclass('apparel.employees') as employees_table,
--        (select count(*) from information_schema.columns
--          where table_schema = 'apparel' and table_name = 'transactions' and column_name = 'employee_id') as employee_column;
--   -> employees_table (empty) | employee_column 0
