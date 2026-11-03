# Rexius Apparel Tracker

Internal app for issuing branded high-vis apparel, tracking inventory, and generating department chargeback reports. Single HTML file on GitHub Pages, data in Supabase.

## Where it lives

- **Repository:** https://github.com/RexiusFleet/rexius-apparel (the Rexius company GitHub account). It was moved here from the personal `andy-rexius` account on 2026-10-29; the old address redirects, but use the new one.
- **Live app:** https://rexiusfleet.github.io/rexius-apparel/ — served by GitHub Pages from the `main` branch, so every push to `main` goes live within a minute or two.
- **Supabase project:** `hibjqcgitqtgmkurghlw` ("AM Projects"), shared with another app. Do not change the project-wide Auth Site URL for this app; it only signs in with email and password and never sends auth emails.

If the repository ever moves again, update the `ALLOWED_ORIGINS` list in both Edge Functions (`supabase/functions/admin-users/index.ts` and `supabase/functions/invoice-extract/index.ts`) to the new `*.github.io` origin and redeploy them, or the browser will be blocked by CORS.

## Files

- `index.html` — the whole app. The Supabase URL and anon key are set at the top of the `<script>` block.
- `assets/` — Rexius logo files referenced by `index.html` (full-colour logo on the login screen, white wordmark in the top bar, leaf mark for the favicon, home-screen icon and login backdrop). Deploy this folder alongside `index.html`.
- `supabase/migrations/20261027170000_move_to_apparel_schema.sql` — **current layout**: everything lives in its own `apparel` schema (`apparel.items`, `apparel.transactions`, …). Run once after an admin has exposed the `apparel` schema under Project Settings → Data API. Older scripts are kept in `sql_history/` for reference only.
- `supabase/migrations/20261029100000_seed_highvis_items.sql` — the starting product list (short-sleeve tee, long-sleeve tee, sweatshirt and safety vest in S–4XL, plus a one-size ball cap: 29 items), built from the "High-Vis Product Info" sheet. Run once, the same way; safe to re-run after the sheet changes, and it renames the original HV-TS-* tee SKUs in place if they were loaded earlier.
- `supabase/migrations/20261102120000_test_product.sql` — test flags on items and invoices, plus the starting **Test Product** (`TEST-S`, `TEST-M`, `TEST-L`). See "Test product and test mode" below. Run once, the same way.
- `testing/` — `test-invoice.pdf`, a sample invoice from a made-up vendor for trying invoice reading in test mode, and `make_test_invoice.py`, which rebuilds it (`python3 testing/make_test_invoice.py`). Deploy this folder alongside `index.html`; the app links to the PDF.
- `supabase/migrations/20261027200000_vendor_aliases.sql` — vendor line matches for automatic invoice reading (`apparel.vendor_aliases`, admin-only). Run once, the same way.
- `supabase/migrations/20261027190000_vendor_invoices.sql` — vendor invoices: creates the private `apparel-invoices` Storage bucket (25 MB per file, PDF/JPEG/PNG/HEIC/WebP), the `apparel.invoices` table and the `invoice_id` link on receive transactions, all admin-only. Run once, the same way.
- `supabase/migrations/20261027180000_drop_employee_no.sql` — drops the employee-number column; people are identified by name and home department only. Run once, the same way, on a project that was set up before it existed.
- `supabase/migrations/20261027120000_apparel_rls.sql` — (historical, `public` schema) the row-level security: locks every apparel table to members of `app_users` (the Supabase project is shared with another app) and adds the helper functions the user-management function needs. Supersedes the RLS section of `apparel_schema_public.sql`; safe to re-run.
- `supabase/functions/admin-users/index.ts` — Edge Function that lets admins create logins, change roles, reset passwords and deactivate/reactivate apparel users without the service-role key ever reaching the browser.
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
4. **Print labels** — print a QR label for each item (Avery 5160, 30 per sheet, print at 100% with no scaling).
5. **Receive** tab — enter your current stock on hand for each item so the counts start accurate.

## Vendor invoices

Admins can keep the clothing vendor's invoices in the app. On the **Receive** tab, pick *Attach a new invoice…* to upload the scan or PDF with the first line of an order; the invoice stays selected so the rest of the order's lines can be received against it, and later lines can pick any recent invoice from the same list. **Admin → Invoices** lists every invoice (searchable by vendor, number or notes) with how many receive lines it covers, and lets you open the file, fix the details, or add an invoice that isn't tied to a receipt. Files live in a private Storage bucket and open through short-lived links, so only admins can see them. Phone users can take a photo of the paper invoice straight from the file picker.

### Receive from an invoice (automatic reading)

At the top of the **Receive** tab, *Receive from an invoice* uploads the scan or PDF and sends it to the `invoice-extract` Edge Function, which has Claude read the header (vendor, number, date, total) and every product line (description, vendor SKU, units, per-unit cost) and match each line to one of your items. The page shows a review table: fix a quantity or cost, pick a different item, skip a line, then confirm. Confirming creates one receive transaction per line (which sets the item's unit cost, as manual receiving does), fills in the invoice record, and saves each line's match.

**Decoration and set-up fees.** Many vendors bill embroidery or screen printing and set-up fees as separate lines. The function returns those as `add_on_charges` instead of stock lines, and `supabase/functions/invoice-extract/spread.ts` spreads their total equally over every piece on the invoice and adds it to each line's unit cost. The review screen shows the breakdown and has a tick box to turn it off. Freight and tax are never spread. Costs are stored to the cent, so a line total can differ from the invoice by a few cents. Test the arithmetic with `node supabase/functions/invoice-extract/spread.test.ts`.

**Vendor line matches.** The first time a vendor line is matched to an item, the choice is saved in `apparel.vendor_aliases` keyed by the vendor's SKU (or the description when there is no SKU) plus colour and size, because one part number often covers every size. The next invoice from that vendor matches those lines automatically and shows them as *Known match*; the model only has to guess at lines it hasn't seen. **Admin → Invoices → Vendor line matches** lists and deletes them.

Setup, once:

1. Run `supabase/migrations/20261027200000_vendor_aliases.sql` in the SQL Editor.
2. Create an API key at <https://platform.claude.com/> and store it as a function secret (never in the page):

   ```bash
   supabase secrets set ANTHROPIC_API_KEY_APPAREL=sk-ant-...
   ```

3. Deploy the function (and re-deploy whenever its `index.ts` changes):

   ```bash
   supabase functions deploy invoice-extract
   ```

The function uses Claude Opus 5.5 and typically costs a few cents per invoice. Only active admins can call it; it only reads files from the private `apparel-invoices` bucket and writes nothing itself. Files over 20 MB and HEIC photos are rejected with a clear message (iPhone users: set the camera to *Most compatible*, or upload a PDF).

## Test product and test mode

For trying the app out, or checking a new feature, without touching real numbers. Test items are kept out of check out, receiving, inventory, labels, recent activity and reports; they only show under **Admin → Items**, with a *Test* tag. The starting one is **Test Product** in S, M and L (`TEST-S`, `TEST-M`, `TEST-L`), with a reorder point of 2 so the low-stock flag can be tried too.

**Admin → Items → Turn on test mode** switches every screen over to the test items, and only them, until you turn it off (the orange bar at the top has a *Turn off* button), sign out or close the tab. It is admin-only and applies to that browser tab only. In test mode:

- **Receive** lists only test items. Invoices uploaded are saved as test invoices, and *Receive from an invoice* matches lines to test items only. Try it with the sample test invoice (`testing/test-invoice.pdf`, linked from the test mode panel and the Receive tab). It should come back as three lines (S 4, M 6, L 2) at $12.50 each: $10.00 plus $2.50 of screen print and set-up spread over the 12 pieces, with $9.50 freight listed as not received. Reading it costs a few cents, like any invoice.
- **Print labels** lists only test items, so you can print a test QR label and scan it on **Check out**.
- **Inventory**, **Recent activity**, **Reports** and **Admin → Invoices** show only test data. A test report's CSV is named `TEST-apparel-chargebacks-…`.
- Checkouts still need a real employee and department. The transaction counts as a test one because its item is a test item.

Outside test mode, real reports, inventory totals and low-stock counts never include test items, and checkout users never see them (scanning a test label tells them it is a test label).

**Clear test activity** (Admin → Items) deletes every test transaction, test invoice (with its file) and test vendor match, and sets the test items' cost back to $0.00, so the next round of testing starts from zero. Real data is not touched.

To add more test items, tick **Test item** when adding an item (or one item per size). It can only be set when an item is created, so an item with real history can never be hidden from reports later.

Setup, once, in this order:

1. Run `supabase/migrations/20261102120000_test_product.sql` in the SQL Editor (adds the test flags and the Test Product).
2. Redeploy the invoice reader, which now keeps test and real items apart:

   ```bash
   supabase functions deploy invoice-extract --no-verify-jwt
   ```

3. Push `index.html` and `testing/` to `main`.

## Day to day

- **Check out** — scan labels (or pick from the list), choose the employee, confirm the department, confirm. The employee's home department is preselected but can be changed.
- **Receive** — add incoming orders. Entering a unit cost updates the item's current cost, which future checkouts are charged at.
- **Inventory** — on-hand counts with low-stock items flagged first. Admins can adjust counts after a physical check and undo mistaken transactions.
- **Reports** — chargebacks by department for any date range, with CSV download.

## Later: annual apparel program

The `items.program` column already exists (`highvis` now). Phase 2 adds `annual` items, an allowance table per employee tier, and a balance check at checkout.
