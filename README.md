# Rexius Apparel Tracker

Internal app for issuing branded high-vis apparel, tracking inventory, and generating department chargeback reports. Single HTML file on GitHub Pages, data in Supabase.

## Where it lives

- **Repository:** https://github.com/RexiusFleet/rexius-apparel (the Rexius company GitHub account). It was moved here from the personal `andy-rexius` account on 2026-10-29; the old address redirects, but use the new one.
- **Live app:** https://rexiusfleet.github.io/rexius-apparel/ — served by GitHub Pages from the `main` branch, so every push to `main` goes live within a minute or two.
- **Supabase project:** `hibjqcgitqtgmkurghlw` ("AM Projects"), shared with another app. Do not change the project-wide Auth Site URL for this app; it only signs in with email and password and never sends auth emails.

If the repository ever moves again, update the `ALLOWED_ORIGINS` list in both Edge Functions (`supabase/functions/admin-users/index.ts` and `supabase/functions/invoice-extract/index.ts`) to the new `*.github.io` origin and redeploy them, or the browser will be blocked by CORS. Also set the `APPAREL_APP_URL` secret to the new address, so low-stock emails link to it.

## Files

- `index.html` — the whole app. The Supabase URL and anon key are set at the top of the `<script>` block.
- `CLAUDE.md` — a short orientation Claude Code reads at the start of every session: where things live, how changes go live and how to test. Keep it in step with this README.
- `assets/` — Rexius logo files referenced by `index.html` (full-colour logo on the login screen, white wordmark in the top bar, leaf mark for the favicon, home-screen icon and login backdrop). Deploy this folder alongside `index.html`.
- `supabase/migrations/20261027170000_move_to_apparel_schema.sql` — **current layout**: everything lives in its own `apparel` schema (`apparel.items`, `apparel.transactions`, …). Run once after an admin has exposed the `apparel` schema under Project Settings → Data API. Older scripts are kept in `sql_history/` for reference only.
- `supabase/migrations/20261029100000_seed_highvis_items.sql` — the starting product list (short-sleeve tee, long-sleeve tee, sweatshirt and safety vest in S–4XL, plus a one-size ball cap: 29 items), built from the "High-Vis Product Info" sheet. Run once, the same way; safe to re-run after the sheet changes, and it renames the original HV-TS-* tee SKUs in place if they were loaded earlier.
- `supabase/migrations/20261102120000_test_product.sql` — test flags on items and invoices, plus the starting **Test Product** (`TEST-S`, `TEST-M`, `TEST-L`). See "Test product and test mode" below. Run once, the same way.
- `supabase/migrations/20261102180000_test_employee_department.sql` — test flags on employees and departments, plus **Test Employee** and **Test Department** (code `TEST`), so a test checkout touches nothing real. Run once, the same way, after the test product script.
- `supabase/migrations/20261102210000_low_stock_alerts.sql` — low-stock emails: the `apparel.low_stock_alerts` queue, the triggers on `apparel.transactions` that fill it when a stock change takes an item down to its reorder point, and the claim function the email function uses. Turns on the `pg_net` extension. See "Low-stock emails" below. Run once, the same way.
- `supabase/migrations/20261103120000_reorder_points_10.sql` — sets the reorder point of every item to 10, except ball caps and test items, which keep theirs. Changing a reorder point never sends a low-stock email. Run once, the same way; safe to re-run.
- `supabase/migrations/20261104120000_packing_slips_and_invoice_costs.sql` — packing slips and invoices: document type, order number and set-up fees on `apparel.invoices`, the `apparel.cost_updates` history, display columns on vendor matches, and the two database functions that receive a packing slip or apply an invoice's costs all at once. See "Packing slips and invoices" below. Run once, the same way, before deploying the `invoice-extract` function that goes with it; safe to re-run.
- `supabase/migrations/20261103150000_fleet_services_tees.sql` — adds the Fleet Services short- and long-sleeve tees in S–4XL (14 items, `FS-SS-*` and `FS-LS-*`, category Shirt, reorder point 12). Run once, the same way; safe to re-run.
- `testing/` — `test-packing-slip.pdf` and `test-invoice.pdf`, a made-up vendor's packing list and invoice for trying packing slip and invoice reading in test mode, and `make_test_documents.py`, which rebuilds both (`python3 testing/make_test_documents.py`). Deploy this folder alongside `index.html`; the app links to the PDFs.
- `supabase/migrations/20261027200000_vendor_aliases.sql` — vendor line matches for automatic document reading (`apparel.vendor_aliases`, admin-only). Run once, the same way.
- `supabase/migrations/20261027190000_vendor_invoices.sql` — vendor invoices: creates the private `apparel-invoices` Storage bucket (25 MB per file, PDF/JPEG/PNG/HEIC/WebP), the `apparel.invoices` table and the `invoice_id` link on receive transactions, all admin-only. Run once, the same way.
- `supabase/migrations/20261027180000_drop_employee_no.sql` — drops the employee-number column; people are identified by name and home department only. Run once, the same way, on a project that was set up before it existed.
- `supabase/migrations/20261027120000_apparel_rls.sql` — (historical, `public` schema) the row-level security: locks every apparel table to members of `app_users` (the Supabase project is shared with another app) and adds the helper functions the user-management function needs. Supersedes the RLS section of `apparel_schema_public.sql`; safe to re-run.
- `supabase/functions/admin-users/index.ts` — Edge Function that lets admins create logins, change roles, reset passwords and deactivate/reactivate apparel users without the service-role key ever reaching the browser.
- `supabase/functions/invoice-extract/` — Edge Function that reads a packing slip or invoice with Claude (`index.ts`). The fee spreading and the matching keys live in `spread.ts`, tested with `node supabase/functions/invoice-extract/spread.test.ts`; `index.html` has copies of the matching keys that must stay identical.
- `supabase/functions/low-stock-alert/` — Edge Function that sends the queued low-stock emails from the app's Gmail account (`index.ts`). The grouping and wording live in `message.ts`, tested with `node supabase/functions/low-stock-alert/message.test.ts`.
- `supabase/config.toml` — Supabase CLI config (turns off gateway JWT checks for `admin-users`, which verifies the token itself).

## Supabase setup (one time)

1. SQL Editor → run `sql_history/apparel_schema_public.sql`, then the files in `supabase/migrations/` in date order. (An existing project that is already on the `apparel` schema needs none of this.)
2. Nothing to expose: the tables live in `public`, which is already available to the API.
3. Authentication → Users → add your own login (email + password).
4. SQL Editor → make yourself the first admin (by email, no UUID needed):
   ```sql
   insert into apparel.app_users (user_id, display_name, role, active)
   select id, 'Your Name', 'admin', true
   from auth.users where lower(email) = lower('you@rexius.com')
   on conflict (user_id) do update set role = 'admin', active = true;
   ```
   Every later user is created from inside the app (Admin → Users) once the steps below are done.

## User management: RLS migration + Edge Function

The Supabase project (`hibjqcgitqtgmkurghlw`) is shared with the applicant-tracker app, so the apparel tables are locked down to rows in `apparel.app_users`, and user administration goes through an Edge Function instead of the browser holding any privileged key. Both steps work with a **Developer** role on the Supabase org; nothing needs project-settings access.

### 1. Run the RLS migration (SQL editor)

1. Supabase dashboard → **SQL Editor** → New query.
2. Paste the whole of `supabase/migrations/20261027120000_apparel_rls.sql` and run it. It is idempotent: it drops the earlier policies by name and recreates everything, so re-running after a change is fine.
   Then do the same with `supabase/migrations/20261027150000_apparel_checkout_role_lockdown.sql`.
3. If this is a fresh project, uncomment the bootstrap block at the bottom (or use the insert in step 4 above) to make the first admin.

What it sets up:

| Who | Can |
|---|---|
| Active member with role `checkout` | read everything (needed for on-hand counts); add employees; record checkout transactions stamped with their own id |
| Active admin | all of the above plus receive/adjust transactions, edit and delete items, departments, employees and transactions, and insert/update/delete rows in `apparel.app_users` (never their own row) |
| Anyone else (incl. other-app logins) | nothing |

The second migration, `supabase/migrations/20261027150000_apparel_checkout_role_lockdown.sql`, is what narrows the checkout role to the first row above. Run it after the first one, the same way. In the app, checkout users see only the **Check out** and **Inventory** tabs; Receive, Reports and Admin are hidden.

`apparel.inventory` is a view with `security_invoker`, so it inherits the item/transaction policies. The migration also creates two helpers that only the service role can call (`apparel.auth_user_id_by_email`, `apparel.admin_list_users`); the function below relies on them, so run the migration before deploying.

### 2. Deploy the `admin-users` Edge Function (Supabase CLI)

Install the CLI once (`npm i -g supabase` or `brew install supabase/tap/supabase`), then from the repo root:

```sh
supabase login                                      # opens the browser; nothing to paste anywhere
supabase link --project-ref hibjqcgitqtgmkurghlw   # creates supabase/.temp (git-ignored)
supabase functions deploy admin-users
```

`supabase/config.toml` sets `verify_jwt = false` for this function so the browser's CORS preflight gets through; the function verifies the caller's token itself and then checks that they are an active admin in `apparel.app_users`. If your CLI version ignores the config file, add `--no-verify-jwt` to the deploy command.

The function uses only the `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` variables that Supabase injects automatically. No secrets are stored in the repo. Requests are accepted from `https://rexiusfleet.github.io`; to test from another origin, set an optional secret `APPAREL_EXTRA_ORIGINS` (comma-separated) with `supabase secrets set`.

Re-run `supabase functions deploy admin-users` whenever `index.ts` changes. Logs are under Edge Functions → admin-users → Logs in the dashboard.

### What admins can do in the app

Admin → **Users**:

- **Add user** — email, display name, role and a temporary password (Generate button). The login is created with the email pre-confirmed and the person is added to the app in one step. If the email already has a login in this project (from the other app), it is added with its existing password and no password is changed.
- **Change role**, **Rename**, **Reset password** (shows the new temporary password once), **Deactivate / Reactivate**.
- Deactivating only flips the apparel `active` flag. The auth user is not banned, because the same login may be in use by the other app.
- An admin cannot change their own role or deactivate themselves; another admin has to do that.

## Deploy to GitHub Pages

Already set up for `RexiusFleet/rexius-apparel`: Settings → Pages → Source "Deploy from a branch", branch `main`, folder `/ (root)`. Pushing to `main` is the deploy.

To stand it up somewhere new:

1. Create a new repository in the `RexiusFleet` organization (private is fine — Pages still works on private repos with GitHub Pro/Team/Enterprise; otherwise use a public repo).
2. Add `index.html`, `assets/` and `testing/` to the root of the repo and commit.
3. Repo → Settings → Pages → Source: "Deploy from a branch" → branch `main`, folder `/ (root)` → Save.
4. After a minute the site is live at `https://<org>.github.io/<repo>/`. Open it on a phone, sign in, and allow camera access when prompted.
5. Add the new origin to `ALLOWED_ORIGINS` in both Edge Functions and redeploy them (see "Where it lives" above).

The anon key is safe to publish: it only grants what the row-level security policies allow, and nothing is readable without an authenticated login that has an active row in `apparel.app_users`.

## First-time data entry

In the app, Admin tab:

1. **Departments** — add each department that gets charged back.
2. **Items** — use "Add one item per size" for each product (e.g. name "Hi-Vis Class 2 Vest", prefix `HV-VEST-C2`, sizes `S, M, L, XL, 2XL, 3XL`). Set the unit cost and reorder threshold.
3. **Employees** — add names and home departments.
4. **Print labels** — print a QR label for each item. **Set all to 1** fills in one of each, which is also the quick way to reprint a full set when labels get worn (Avery 5160, 30 per sheet, print at 100% with no scaling).
5. **Receive** tab — enter your current stock on hand for each item so the counts start accurate.

## Packing slips and invoices

What arrived and what it cost come from two different papers, so the app treats them separately.

- **Packing slip.** It comes in the box and lists what actually shipped. Reading one adds those quantities to inventory and leaves costs alone. If the slip is marked up by hand, for example 15 printed and 14 written beside it, the handwritten count is the one received, and the review shows *Ordered 15*.
- **Invoice.** It can arrive before or after the goods and can cover several shipments. Reading one adds no stock. It sets each item's current cost to the garment price plus its share of the logo charges, which future checkouts are charged at. Every change is kept in `apparel.cost_updates`.
- **Set-up fees** (screen set-up, reorder or reset fees) are never part of item cost, so the price per piece stays steady from order to order. They are recorded on the invoice and charged to **department 10** in the chargeback report.

### Reading one

At the top of the **Receive** tab, *Read a packing slip or invoice*: choose which it is, pick the scan, photo or PDF, and press Read. The file is saved first, then the `invoice-extract` Edge Function has Claude read it and match each garment and size to one of your items. Nothing is recorded until you confirm the review.

- **Packing slip review.** Vendor, order number and date at the top. One row per garment and size, with the received quantity, the matched item and how many are on hand now. Confirm with *Receive N pieces*. The app warns before receiving the same vendor order number twice. Confirming runs `apparel.receive_packing_slip`, which adds every line in one go or none of them.
- **Invoice review.** Vendor, invoice number, date and total at the top. A tick box adds the logo charges to item cost, spread equally over every piece, or over each order's own pieces when the invoice is split into sections. The set-up fees box shows what goes to department 10 and can be corrected. Freight and tax are listed but never added to cost. Each row shows the garment price, the logo share, the new cost and the item's cost now. A totals line checks garments, logos, set-up and other charges against the invoice total. An item billed on more than one line gets the quantity-weighted average. Confirm with *Update N item costs*, which runs `apparel.apply_invoice_costs`, again all or nothing.
- **Wrong type.** If you read an invoice as a packing slip, or the other way round, the review says so and offers to switch before anything is saved.

For invoice 66123 from Eugene Silkscreen, garments $9.35 and $22.95 plus $8.25 of logos become costs of $17.60 and $31.20, and the $45.00 set-up fee goes to department 10.

**Vendor line matches.** When you confirm with *Remember* ticked, the match is saved in `apparel.vendor_aliases`. The key is the vendor's part number without any size suffix (`2400_4X` is `2400`), plus colour, size and design, because one part number covers every size and colour and the same blank shirt can carry different designs. Vendor names ignore punctuation and endings like Inc., and sizes are spelled one way (`LG` is `L`, `4X` is `4XL`), so a match learned from a packing slip works on the invoice too. The next document from that vendor shows those lines as *Known match*. **Admin → Documents → Vendor line matches** lists and deletes them. The rules live in `supabase/functions/invoice-extract/spread.ts` with copies in `index.html` that must stay identical.

### Documents

**Admin → Documents** lists every packing slip, invoice and other vendor paperwork, filterable by type and searchable by vendor, number or notes. Each row says what the document did: *Received, 3 lines*, *Costs set on 2 items, set-up $45.00*, or *Not received yet*. **Open** shows the file through a short-lived link, plus any costs the invoice set. **Read** appears on a packing slip or invoice that hasn't been used yet and takes it to the Receive tab. **Edit** fixes the details, including type and set-up fees, without undoing what it already did. **Add a document** files paperwork without reading it; an invoice filed this way can carry set-up fees for the report. Files live in a private Storage bucket, so only admins can see them. The manual *Receive one item* form can attach a document too.

### Set-up fees in the chargeback report

**Reports** adds each invoice's set-up fees to department 10, dated by the invoice date, with a *vendor set-up fees* total at the top. Run it for *Last month* for the monthly figure; the CSV has one row per invoice. Department 10 is whichever department has code `10`. Until one exists, the fees show under *Department 10* with a reminder to add it under Admin, Departments. In test mode they go to the test department.

### Setup

1. Run `supabase/migrations/20261104120000_packing_slips_and_invoice_costs.sql` in the SQL Editor. Earlier setups also needed `20261027200000_vendor_aliases.sql`.
2. The Claude key is a function secret, set once and never in the page:

   ```bash
   supabase secrets set ANTHROPIC_API_KEY_APPAREL=sk-ant-...
   ```

3. Deploy the function, and redeploy whenever anything in `supabase/functions/invoice-extract/` changes:

   ```bash
   supabase functions deploy invoice-extract --no-verify-jwt
   ```

4. Push `index.html` and `testing/` to `main`.

The function uses Claude Opus 5.5 and typically costs a few cents per document. Only active admins can call it. It only reads files from the private `apparel-invoices` bucket and writes nothing itself. Files over 20 MB and HEIC photos are rejected with a clear message: iPhone users can set the camera to *Most compatible* or upload a PDF.

## Test product and test mode

For trying the app out, or checking a new feature, without touching real numbers or real people. Test items, employees and departments are kept out of check out, receiving, inventory, labels, recent activity and reports; they only show in the Admin lists (Items, Employees, Departments), with a *Test* tag. The starting set is **Test Product** in S, M and L (`TEST-S`, `TEST-M`, `TEST-L`), with a reorder point of 2 so the low-stock flag can be tried too, and **Test Employee**, whose home department is **Test Department** (code `TEST`).

**Admin → Test mode → Turn on test mode** switches every screen over to test data, and only test data, until you turn it off (the orange bar at the top has a *Turn off* button), sign out or close the tab. It is admin-only and applies to that browser tab only. In test mode:

- **Receive** lists only test items. Documents uploaded are saved as test documents, and reading one matches lines to test items only. Try the two samples, linked from Admin → Test mode and the Receive tab. Read `testing/test-packing-slip.pdf` as a packing slip: S 4, M 6 and L 1 come back, with L showing *Ordered 2*, so 11 pieces are received. Read `testing/test-invoice.pdf` as an invoice: each size gets a new cost of $11.50, which is $10.00 plus $1.50 of screen print. The $12.00 set-up fee goes to the test department in the report, $9.50 freight stays out of cost, and the totals match $159.50. Each read costs a few cents.
- **Print labels** lists only test items, so you can print a test QR label and scan it on **Check out**.
- **Inventory**, **Recent activity**, **Reports** and **Admin → Documents** show only test data. A test report's CSV is named `TEST-apparel-chargebacks-…`.
- **Check out** offers only test employees and test departments, so a test checkout touches nothing real: Test Product to Test Employee, charged to Test Department.

Outside test mode, real reports, inventory totals and low-stock counts never include test data. The pick lists, employee search and department dropdowns (including the Reports department filter) never offer test records, and checkout users never see them (scanning a test label tells them it is a test label).

**Anything you add while test mode is on is a test record**: items (including one item per size), employees (including a new employee added from the check out screen), departments and documents. Anything added outside test mode is real. The flag is only set when a record is created, so a real item, employee or department with history can never be hidden from reports later.

**Clear test activity** (Admin → Test mode) deletes every test transaction, test document (with its file), test cost change and test vendor match, and sets the test items' cost back to $0.00, so the next round of testing starts from zero. Test employees and departments are kept for next time; delete extra ones by hand (deactivate, then delete) after clearing. Real data is not touched.

Setup, once, in this order:

1. Run `supabase/migrations/20261102120000_test_product.sql` in the SQL Editor (adds the test flags for items and invoices, and the Test Product).
2. Run `supabase/migrations/20261102180000_test_employee_department.sql` the same way (adds the test flags for employees and departments, and Test Employee and Test Department).
3. Redeploy the invoice reader, which keeps test and real items apart:

   ```bash
   supabase functions deploy invoice-extract --no-verify-jwt
   ```

4. Push `index.html` and `testing/` to `main`.

## Low-stock emails

When a stock change takes an item from above its reorder point to at or below it (the moment the Inventory tab starts flagging it **Low**), every active admin gets an email from the app's Gmail account. It lists the item, size, SKU, how many are left and the reorder point, with a link to the app. A check out that takes several items down at once sends one email listing them all. An item that stays low doesn't email again: it has to be restocked above its reorder point and drop again. Check outs, count adjustments and undoing a receipt can all set it off. Adding items, changing a reorder point and reactivating an item never do, and inactive items never email. To stop someone's emails, make them a checkout user or deactivate them (Admin → Users).

Test items email only the admin who made the change, with **[TEST]** at the start of the subject, so the whole thing can be tried in test mode without bothering anyone else. Clearing test activity never emails.

How it works: triggers on `apparel.transactions` queue a row in `apparel.low_stock_alerts` for each item that crossed its reorder point, then call the `low-stock-alert` Edge Function through `pg_net`. The function sends what is queued and records on each row whether it was sent (and to whom), failed (with the error) or skipped. A failed email is tried again the next time an item drops, up to 5 tries within a day. A check out never fails because of an email problem. The call from the database carries nothing, and the function only sends what is already queued, so it needs no login and is deployed with `--no-verify-jwt`. The function's address is written into the SQL file; if the app ever moves to another Supabase project, change it there and run the file again.

Setup, once, in this order:

1. **Gmail account.** Create a Gmail account just for the app (for example `rexiusapparel@gmail.com`). Turn on 2-Step Verification (Google Account → Security), then create an app password at <https://myaccount.google.com/apppasswords> and name it something like "Rexius Apparel". Google shows it once, as four groups of four letters.
2. **Secrets.** From the repo folder, with the real address and app password (the spaces in the password are fine):

   ```bash
   supabase secrets set GMAIL_ADDRESS_APPAREL=your-apparel-address@gmail.com GMAIL_APP_PASSWORD_APPAREL="xxxx xxxx xxxx xxxx"
   ```

3. **SQL.** Run `supabase/migrations/20261102210000_low_stock_alerts.sql` in the SQL Editor. Its first statement turns on the `pg_net` extension; if that statement fails, turn on **pg_net** under Database → Extensions and run the file again.
4. **Function.**

   ```bash
   supabase functions deploy low-stock-alert --no-verify-jwt
   ```

5. **Try it.** Turn on test mode and click **Clear test activity**, so the test items start at 0. Receive 5 of one Test Product size, then check 3 of them out to Test Employee. That takes it to 2, its reorder point, and a **[TEST]** email should reach you within a minute (look in Spam the first time). Clear test activity afterwards.

The emails cost nothing: Gmail is free and the function's few calls a day are well inside the Supabase plan. Changing the Gmail account's password, or turning off its 2-Step Verification, cancels the app password. The emails then stop (the rows show *failed*) until you create a new app password and set it again with `supabase secrets set GMAIL_APP_PASSWORD_APPAREL="..."`; no redeploy is needed. To link the emails to a different address than the live app, set the optional `APPAREL_APP_URL` secret.

If an email doesn't arrive:

- Supabase dashboard → **Edge Functions → low-stock-alert → Logs** shows each call and any Gmail error.
- In the SQL Editor, the latest alerts and what happened to each:

  ```sql
  select id, created_at, status, attempts, on_hand, reorder_threshold, sent_to, error
  from apparel.low_stock_alerts order by id desc limit 20;
  ```

  *sent* means Gmail accepted it, so look in Spam. *failed* shows the error; "Username and Password not accepted" means the app password is wrong or was cancelled. *skipped* means there was nobody to send it to. A row still *pending* means the function was never reached or stopped before sending. Check that it's deployed and the secrets are set, then look at what the database got back (kept for 6 hours):

  ```sql
  select id, status_code, content, error_msg, created from net._http_response order by id desc limit 10;
  ```

## Day to day

- **Check out** — scan labels (or pick from the list), choose the employee, confirm the department, confirm. The employee's home department is preselected but can be changed.
- **Receive** — read a packing slip to add what arrived, and read the invoice when it comes to set costs. *Receive one item* is there for anything else; entering a unit cost there also updates the item's current cost, which future checkouts are charged at.
- **Inventory** — on-hand counts with low-stock items flagged first. Admins can adjust counts after a physical check and undo mistaken transactions.
- **Reports** — chargebacks by department for any date range, including vendor set-up fees under department 10, with CSV download.
- **Display** — the half-circle button in the top bar picks Auto (follows the phone or computer's own light/dark setting), Light or Dark. Each device remembers its own choice. Printed labels are always black on white. Colours live as variables at the top of the `<style>` block, light first and then the dark overrides; a new screen should use those variables rather than fixed colours so it works in both.

## Later: annual apparel program

The `items.program` column already exists (`highvis` now). Phase 2 adds `annual` items, an allowance table per employee tier, and a balance check at checkout.
