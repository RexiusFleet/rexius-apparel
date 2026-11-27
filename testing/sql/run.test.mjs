// Tests for the rules that live in the database: who can do what, stock and cost, low-stock alerts,
// overflow and invoice coding reports. Everything runs in an in-memory Postgres built from the repo's own
// SQL files (see harness.mjs). Nothing here touches the live Supabase project.
//
//   cd testing/sql && npm install     (once)
//   node run.test.mjs                 (or: npm test)
import assert from "node:assert/strict";
import { buildDatabase, rerun, session } from "./harness.mjs";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// A fresh database for each test, with two departments, an admin, two checkout users and one item at $10.00
// with a reorder point of 2.
async function setup() {
  const db = await buildDatabase();
  const s = session(db);
  const dept10 = (await s.one("insert into apparel.departments (name, code) values ('Admin', '10') returning id")).id;
  const dept20 = (await s.one("insert into apparel.departments (name, code) values ('Yard', '20') returning id")).id;
  const admin = await s.addUser("Ada", "admin", dept10);
  const pat = await s.addUser("Pat", "checkout", dept20);
  const sam = await s.addUser("Sam", "checkout", dept20);
  const gone = await s.addUser("Gone", "checkout", dept20, false);
  const item = (await s.one("insert into apparel.items (sku, name, size, unit_cost, reorder_threshold) values ('VEST-L', 'Vest', 'L', 10, 2) returning id")).id;
  const onHand = async (id = item) => (await s.one("select on_hand from apparel.inventory_all where id = $1", [id])).on_hand;
  // Stock changes entered the way the SQL Editor would (no login), so each test controls cost and date exactly.
  const tx = (type, qty, extra = {}) => {
    const row = { type, item_id: item, qty_change: qty, performed_by: admin, ...(type === "checkout" ? { department_id: dept20 } : {}), ...extra };
    const cols = Object.keys(row);
    return s.one(`insert into apparel.transactions (${cols.join(", ")}) values (${cols.map((_, i) => "$" + (i + 1)).join(", ")}) returning *`, Object.values(row));
  };
  return { db, s, dept10, dept20, admin, pat, sam, gone, item, onHand, tx };
}

/* ---------------- Who can do what ---------------- */

test("every app table has row-level security, and nothing is open to visitors who aren't signed in", async () => {
  const { s } = await setup();
  const open = await s.q("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'apparel' and c.relkind = 'r' and not c.relrowsecurity");
  assert.deepEqual(open, [], "tables without row-level security");
  const anonTables = await s.q("select table_name, privilege_type from information_schema.role_table_grants where table_schema = 'apparel' and grantee in ('anon', 'PUBLIC')");
  assert.deepEqual(anonTables, [], "tables or views a visitor can touch");
  // Trigger functions can't be called directly, so only ordinary functions matter here.
  const anonFns = await s.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'apparel' and p.prorettype <> 'trigger'::regtype and has_function_privilege('anon', p.oid, 'execute') order by 1`);
  assert.deepEqual(anonFns, [], "functions a visitor can call");
});

test("a checkout user can check out as themselves and nothing else", async () => {
  const { s, item, pat, sam, dept20, tx, onHand } = await setup();
  await tx("receive", 10);
  await s.as(pat, async () => {
    assert.equal((await s.q("select id from apparel.items")).length > 0, true, "can read items");
    await s.q("insert into apparel.transactions (type, item_id, qty_change, department_id, performed_by) values ('checkout', $1, -1, $2, $3)", [item, dept20, pat]);
    assert.match(await s.fails(() => s.q("insert into apparel.transactions (type, item_id, qty_change, department_id, performed_by) values ('checkout', $1, -1, $2, $3)", [item, dept20, sam])), /row-level security/, "not as someone else");
    assert.match(await s.fails(() => s.q("insert into apparel.transactions (type, item_id, qty_change, performed_by) values ('receive', $1, 5, $2)", [item, pat])), /row-level security/, "no receiving");
    assert.match(await s.fails(() => s.q("insert into apparel.transactions (type, item_id, qty_change, performed_by) values ('adjust', $1, 5, $2)", [item, pat])), /row-level security/, "no adjusting");
    assert.equal((await s.q("update apparel.items set unit_cost = 0 where id = $1 returning id", [item])).length, 0, "can't change an item");
    assert.equal((await s.q("delete from apparel.transactions returning id")).length, 0, "can't undo");
    assert.equal((await s.q("select id from apparel.invoices")).length, 0, "no vendor documents");
    assert.match(await s.fails(() => s.q("select apparel.move_overflow($1, 1)", [item])), /Only admins/);
    assert.match(await s.fails(() => s.q("select apparel.coding_report(gen_random_uuid())")), /Only admins/);
    assert.match(await s.fails(() => s.q("select * from apparel.admin_list_users()")), /permission denied/);
  });
  assert.equal(await onHand(), 9);
});

test("a checkout user sees their own check outs only, but the full stock count", async () => {
  const { s, item, pat, sam, dept20, tx } = await setup();
  await tx("receive", 10);
  for (const who of [pat, sam, sam]) await s.as(who, () => s.q("insert into apparel.transactions (type, item_id, qty_change, department_id, performed_by) values ('checkout', $1, -1, $2, $3)", [item, dept20, who]));
  await s.as(pat, async () => {
    const mine = await s.q("select type, performed_by from apparel.transactions");
    assert.deepEqual(mine, [{ type: "checkout", performed_by: pat }]);
    assert.equal((await s.one("select on_hand from apparel.inventory where id = $1", [item])).on_hand, 7);
  });
});

test("an inactive user, and a login that isn't an app user, see nothing and can do nothing", async () => {
  const { s, item, gone, dept20, tx } = await setup();
  await tx("receive", 10);
  const stranger = (await s.one("insert into auth.users (email) values ('other-app@example.com') returning id")).id;   // a login from the other app in the shared project
  for (const who of [gone, stranger]) await s.as(who, async () => {
    for (const t of ["items", "inventory", "departments", "transactions", "invoices", "vendor_aliases", "cost_updates", "coding_reports", "overflow_moves", "low_stock_alerts"])
      assert.equal((await s.q(`select 1 from apparel.${t}`)).length, 0, `${t} is hidden`);
    assert.match(await s.fails(() => s.q("insert into apparel.transactions (type, item_id, qty_change, department_id, performed_by) values ('checkout', $1, -1, $2, $3)", [item, dept20, who])), /row-level security/);
  });
});

test("an admin can record a check out for someone else, and who entered it can't be changed", async () => {
  const { s, item, admin, pat, dept20, tx } = await setup();
  await tx("receive", 10);
  await s.as(admin, async () => {
    const t = await s.one("insert into apparel.transactions (type, item_id, qty_change, department_id, performed_by, entered_by) values ('checkout', $1, -1, $2, $3, $3) returning id, performed_by, entered_by", [item, dept20, pat]);
    assert.equal(t.performed_by, pat); assert.equal(t.entered_by, admin, "entered_by is the login, whatever was sent");
    const u = await s.one("update apparel.transactions set entered_by = $2, notes = 'fixed' where id = $1 returning entered_by, notes", [t.id, pat]);
    assert.equal(u.entered_by, admin); assert.equal(u.notes, "fixed");
  });
});

/* ---------------- Cost ---------------- */

test("a check out is charged at the item's cost at that moment, whatever the request sends", async () => {
  const { s, item, pat, dept20, tx } = await setup();
  await tx("receive", 10);
  const out = (extra = {}) => s.as(pat, () => {
    const row = { type: "checkout", item_id: item, qty_change: -1, department_id: dept20, performed_by: pat, ...extra }, cols = Object.keys(row);
    return s.one(`insert into apparel.transactions (${cols.join(", ")}) values (${cols.map((_, i) => "$" + (i + 1)).join(", ")}) returning unit_cost, report_id, invoice_id, created_at > now() - interval '1 minute' as recent`, Object.values(row));
  });
  let r = await out({ unit_cost: 0.01, created_at: "2020-01-01" });
  assert.equal(Number(r.unit_cost), 10); assert.equal(r.recent, true, "the date is when it was recorded");
  await s.q("update apparel.items set unit_cost = 12.34 where id = $1", [item]);
  r = await out({ unit_cost: 10 });   // a page that loaded before the cost changed
  assert.equal(Number(r.unit_cost), 12.34);
  r = await out();                    // what the page sends now: no cost at all
  assert.equal(Number(r.unit_cost), 12.34);
});

test("the SQL Editor keeps the cost and date it is given, and a missing cost is filled in", async () => {
  const { tx } = await setup();
  await tx("receive", 10);
  let r = await tx("checkout", -1, { unit_cost: 3, created_at: "2020-01-01T00:00:00Z" });
  assert.equal(Number(r.unit_cost), 3); assert.equal(new Date(r.created_at).getUTCFullYear(), 2020);
  r = await tx("checkout", -1);
  assert.equal(Number(r.unit_cost), 10);
});

test("a receive with a cost sets the item's cost; one without leaves it alone", async () => {
  const { s, item, tx } = await setup();
  const cost = async () => Number((await s.one("select unit_cost from apparel.items where id = $1", [item])).unit_cost);
  await tx("receive", 5); assert.equal(await cost(), 10);
  await tx("receive", 5, { unit_cost: 11.5 }); assert.equal(await cost(), 11.5);
});

test("a packing slip adds stock and leaves cost alone; an invoice sets cost and adds no stock", async () => {
  const { s, item, admin, onHand } = await setup();
  const doc = async (type) => (await s.one("insert into apparel.invoices (vendor, doc_type, file_path, file_name, uploaded_by) values ('Acme', $1, gen_random_uuid()::text, 'f.pdf', $2) returning id", [type, admin])).id;
  const cost = async () => Number((await s.one("select unit_cost from apparel.items where id = $1", [item])).unit_cost);
  await s.login(admin);
  const slip = await doc("packing_slip");
  assert.equal((await s.one("select apparel.receive_packing_slip($1, $2, $3) n", [slip, { vendor: "Acme Inc", order_no: "77", date: "2026-11-01" }, [{ item_id: item, qty: 6, notes: "Packing slip: Vest L" }]])).n, 1);
  assert.equal(await onHand(), 6); assert.equal(await cost(), 10);
  assert.match(await s.fails(() => s.q("select apparel.receive_packing_slip($1, $2, $3)", [slip, {}, [{ item_id: item, qty: 0 }]])), /whole quantity of 1 or more/);

  const inv = await doc("invoice");
  await s.q("select apparel.apply_invoice_costs($1, $2, $3)", [inv, { vendor: "Acme", invoice_no: "A1", date: "2026-11-02", total: "200.00", setup_fees: "25" },
    [{ item_id: item, qty: 6, invoice_price: 9, decoration: 2.5, new_cost: 11.5, description: "Vest L" }]]);
  assert.equal(await cost(), 11.5); assert.equal(await onHand(), 6, "no stock from an invoice");
  const log = await s.one("select old_cost, new_cost from apparel.cost_updates where invoice_id = $1", [inv]);
  assert.deepEqual([Number(log.old_cost), Number(log.new_cost)], [10, 11.5]);
  assert.equal(Number((await s.one("select setup_fees from apparel.invoices where id = $1", [inv])).setup_fees), 25, "set-up fees stay on the invoice, not in cost");
  assert.match(await s.fails(() => s.q("select apparel.apply_invoice_costs($1, $2, $3)", [inv, {}, [{ item_id: item, new_cost: 1 }, { item_id: item, new_cost: 2 }]])), /more than one line/);
  assert.equal(await cost(), 11.5, "a refused invoice changes nothing");
});

/* ---------------- Low-stock alerts ---------------- */

test("an alert is queued once, when stock crosses the reorder point", async () => {
  const { s, tx } = await setup();   // reorder point 2
  const alerts = () => s.q("select kind, on_hand, reorder_threshold from apparel.low_stock_alerts order by id");
  const calls = async () => Number((await s.one("select count(*) n from net.calls")).n);
  await tx("receive", 5);
  await tx("checkout", -2); assert.deepEqual(await alerts(), [], "3 left: above the reorder point");
  await tx("checkout", -1);
  assert.deepEqual(await alerts(), [{ kind: "low", on_hand: 2, reorder_threshold: 2 }]);
  assert.equal(await calls(), 1, "the email function is called once");
  await tx("checkout", -1); assert.equal((await alerts()).length, 1, "staying low doesn't alert again");
  await tx("receive", 5); await tx("checkout", -4);
  assert.equal((await alerts()).length, 2, "restocked and dropped again: a new alert");
});

test("an item with no reorder point never alerts and is never Low", async () => {
  const { s, item, admin, tx } = await setup();
  await s.q("update apparel.items set reorder_threshold = null where id = $1", [item]);
  await tx("receive", 3); await tx("checkout", -3);
  assert.equal((await s.q("select 1 from apparel.low_stock_alerts")).length, 0);
  const v = await s.as(admin, () => s.one("select on_hand, low_stock, refill from apparel.inventory where id = $1", [item]));
  assert.deepEqual(v, { on_hand: 0, low_stock: null, refill: false });
});

test("undoing a receive can alert; a stock change never fails because of the alert step", async () => {
  const { s, tx } = await setup();
  const r = await tx("receive", 5);
  await s.q("delete from apparel.transactions where id = $1", [r.id]);   // 5 -> 0
  assert.equal((await s.q("select 1 from apparel.low_stock_alerts")).length, 1);
  await s.q("drop function net.http_post(text, jsonb, integer)");          // the email call is unavailable
  await tx("receive", 5); await tx("checkout", -4);
  assert.equal((await s.q("select 1 from apparel.low_stock_alerts")).length, 2, "still recorded and still queued");
});

/* ---------------- Overflow ---------------- */

test("overflow moves change where stock is, never how much there is", async () => {
  const { s, item, admin, tx, onHand } = await setup();
  await tx("receive", 20);
  await s.login(admin);
  const view = () => s.as(admin, () => s.one("select on_hand, overflow, on_rack, refill, low_stock, overflow_location from apparel.inventory where id = $1", [item]));
  await s.q("select apparel.move_overflow($1, 12, 'Box 3')", [item]);
  assert.deepEqual(await view(), { on_hand: 20, overflow: 12, on_rack: 8, refill: false, low_stock: false, overflow_location: "Box 3" });
  assert.match(await s.fails(() => s.q("select apparel.move_overflow($1, 9)", [item])), /Only 8 on the rack/);
  assert.match(await s.fails(() => s.q("select apparel.move_overflow($1, -13)", [item])), /Only 12 in overflow/);
  await s.q("select apparel.move_overflow($1, -12)", [item]);
  assert.equal((await view()).overflow_location, null, "the box note is cleared when overflow is empty");
  assert.equal(await onHand(), 20);
});

test("the rack reaching the reorder point with overflow left is a Refill, not a Low", async () => {
  const { s, item, admin, tx } = await setup();   // reorder point 2
  await tx("receive", 20);
  await s.login(admin); await s.q("select apparel.move_overflow($1, 12)", [item]); await s.login(null);
  await tx("checkout", -6);   // rack 8 -> 2
  assert.deepEqual(await s.q("select kind, on_hand, overflow from apparel.low_stock_alerts"), [{ kind: "refill", on_hand: 14, overflow: 12 }]);
  const v = await s.as(admin, () => s.one("select refill, low_stock from apparel.inventory where id = $1", [item]));
  assert.deepEqual(v, { refill: true, low_stock: false });
});

test("when stock drops below the overflow count, overflow is cut to match", async () => {
  const { s, item, admin, tx } = await setup();
  await tx("receive", 20);
  await s.login(admin); await s.q("select apparel.move_overflow($1, 12)", [item]); await s.login(null);
  await tx("adjust", -15);   // 5 left, 12 said to be in overflow
  assert.equal(Number((await s.one("select sum(qty) n from apparel.overflow_moves where item_id = $1", [item])).n), 5);
  const v = await s.as(admin, () => s.one("select on_hand, overflow, on_rack from apparel.inventory where id = $1", [item]));
  assert.deepEqual(v, { on_hand: 5, overflow: 5, on_rack: 0 });
});

/* ---------------- Invoice coding reports ---------------- */

// An applied invoice with a total and set-up fees, and check outs of $10 pieces on given days.
async function codingSetup() {
  const c = await setup();
  const { s, admin, tx } = c;
  await tx("receive", 100);
  const invoice = async (total, setup = 0) => (await s.one("insert into apparel.invoices (vendor, doc_type, invoice_no, total, setup_fees, file_path, file_name, uploaded_by) values ('Acme', 'invoice', $4, $1, $2, gen_random_uuid()::text, 'f.pdf', $3) returning id", [total, setup, admin, "A" + total])).id;
  const out = (qty, day, dept = c.dept20) => tx("checkout", -qty, { department_id: dept, created_at: `2026-11-${String(day).padStart(2, "0")}T12:00:00Z` });
  const report = async (id, save = false) => (await s.one("select apparel.coding_report($1, $2) r", [id, save])).r;
  const sums = (r) => Number(r.report.setup_fees) + Number(r.report.charges_total) + Number(r.report.gap) + Number(r.report.stock_up);
  await s.login(admin);
  return { ...c, invoice, out, report, sums };
}

test("coding report: check outs fill the invoice, and what's left is Stock Up", async () => {
  const { invoice, out, report, sums } = await codingSetup();
  await out(2, 1); await out(3, 2);                         // $20 + $30
  const r = await report(await invoice(100, 15));
  assert.equal(r.saved, false);
  assert.deepEqual([r.report.setup_fees, r.report.charges_total, r.report.stock_up, r.report.gap, r.report.carried_count].map(Number), [15, 50, 35, 0, 0]);
  assert.equal(sums(r), 100, "the lines add up to the invoice total");
  assert.deepEqual(r.lines.map((l) => [l.dept_code, l.qty, Number(l.amount), l.checked_out_by]), [["20", 2, 20, "Ada"], ["20", 3, 30, "Ada"]]);
});

test("coding report: check outs that don't fit carry over, oldest first, and the gap goes to department 10", async () => {
  const { s, invoice, out, report, sums } = await codingSetup();
  await out(4, 1); await out(5, 2); await out(1, 3);        // $40, $50, $10
  const first = await invoice(70, 5);                       // $65 to fill: only the $40 fits
  let r = await report(first, true);
  assert.equal(r.saved, true);
  assert.deepEqual([r.report.charges_total, r.report.gap, r.report.stock_up, r.report.carried_count, r.report.carried_total].map(Number), [40, 25, 0, 2, 60]);
  assert.equal(sums(r), 70);
  // Saved: asking again returns the same report, and its check out is taken.
  assert.deepEqual((await report(first)).report, r.report);
  assert.deepEqual((await report(first, true)).report, r.report, "saving again changes nothing");
  assert.equal((await s.q("select 1 from apparel.coding_reports")).length, 1);
  // The next invoice takes what carried over, and nothing twice.
  r = await report(await invoice(100), true);
  assert.deepEqual([r.report.charges_total, r.report.stock_up, r.report.carried_count].map(Number), [60, 40, 0]);
  assert.equal(Number((await s.one("select count(*) n from apparel.transactions where type = 'checkout' and report_id is null")).n), 0, "every check out is on exactly one report");
});

test("coding report: a preview changes nothing, and deleting a report frees its check outs", async () => {
  const { s, invoice, out, report } = await codingSetup();
  await out(2, 1);
  const inv = await invoice(50);
  await report(inv);
  assert.equal((await s.q("select 1 from apparel.coding_reports")).length, 0);
  const saved = await report(inv, true);
  assert.equal(Number((await s.one("select count(*) n from apparel.transactions where report_id = $1", [saved.report.id])).n), 1);
  await s.q("delete from apparel.coding_reports where id = $1", [saved.report.id]);
  assert.equal(Number((await s.one("select count(*) n from apparel.transactions where type = 'checkout' and report_id is null")).n), 1);
});

test("coding report: test items' check outs never land on a real invoice", async () => {
  const { s, admin, dept20, invoice, out, report } = await codingSetup();
  const testItem = (await s.one("select id from apparel.items where is_test limit 1")).id;
  await s.login(null);
  await s.q("insert into apparel.transactions (type, item_id, qty_change, unit_cost, department_id, performed_by) values ('checkout', $1, -1, 99, $2, $3)", [testItem, dept20, admin]);
  await s.login(admin);
  await out(1, 1);
  const r = await report(await invoice(50));
  assert.deepEqual(r.lines.map((l) => Number(l.amount)), [10]);
});

/* ---------------- The SQL files themselves ---------------- */

test("the newest SQL files really are safe to re-run", async () => {
  const { db, s, tx, onHand } = await setup();
  await tx("receive", 5);
  // An item taken back out of side inventory in the app stays out when the file is run again.
  const fleet = (await s.one("select id from apparel.items where side limit 1")).id;
  await s.q("update apparel.items set side = false, reorder_threshold = 4 where id = $1", [fleet]);
  for (const f of ["20261124120000_side_inventory", "20261127120000_checkout_cost_from_database"]) assert.equal(await rerun(db, f), null, `${f} re-runs cleanly`);
  assert.equal(await onHand(), 5);
  assert.deepEqual(await s.one("select side, reorder_threshold from apparel.items where id = $1", [fleet]), { side: false, reorder_threshold: 4 });
});

test("old SQL files run again by mistake: most stop with an error and change nothing", async () => {
  const { db, s } = await setup();
  const source = async (fn) => (await s.one("select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'apparel' and p.proname = $1", [fn])).prosrc;
  const before = await source("queue_low_stock_alerts");
  for (const f of ["20261102210000_low_stock_alerts", "20261118190000_item_colors", "20261118220000_checkout_users_own_activity", "20261123120000_overflow"])
    assert.notEqual(await rerun(db, f), null, `${f} should refuse to run again`);
  assert.equal(await source("queue_low_stock_alerts"), before, "the low-stock trigger is untouched");
});

// The one exception, which is why that file carries a warning at the top.
test("the old coding reports file run again breaks coding reports, and the check out by department file repairs them", async () => {
  const { db, s, invoice, report } = await codingSetup();
  const inv = await invoice(50);
  assert.equal(await rerun(db, "20261110120000_invoice_coding_reports"), null, "it runs without any error");
  assert.match(await s.fails(() => report(inv)), /employees/);
  assert.equal(await rerun(db, "20261118120000_checkout_by_department"), null);
  assert.equal((await report(inv)).saved, false, "coding reports work again");
});

/* ---------------- Runner ---------------- */

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok    ${t.name}`); }
  catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${String(e.message).split("\n").join("\n      ")}`); }
}
console.log(failed ? `\n${failed} of ${tests.length} SQL tests failed` : `\nall ${tests.length} SQL tests passed`);
process.exit(failed ? 1 : 0);
