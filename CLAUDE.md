# Rexius Apparel Tracker

Internal app for issuing high-vis apparel to employees, tracking inventory and producing department chargeback reports. The front end is a single page (`index.html`) on GitHub Pages. Data and server code live in Supabase. **README.md is the full manual**: read the section for a feature before changing it, and keep it up to date in the same commit.

This repository is public. Never commit secrets, passwords or personal email addresses.

## Where things live

- **Live app:** https://rexiusfleet.github.io/rexius-apparel/. Every push to `main` goes live within a minute or two.
- **Supabase project:** `hibjqcgitqtgmkurghlw`, shared with another app.
  - Everything for this app is in the `apparel` schema.
  - Don't change project-wide settings.
  - Don't send requests to the project from tests; it's live data.
- **`index.html`:** the whole front end, with no build step. Colours are CSS variables, with light values first and dark overrides after.
- **`supabase/migrations/`:** SQL files, run by hand in the SQL Editor in date order. Write them to be safe to re-run.
- **`supabase/functions/`:** Edge Functions. Gateway settings are in `supabase/config.toml`, and all deploy with `--no-verify-jwt`.
  - `admin-users`: admin-only user management.
  - `invoice-extract`: reads a packing slip or invoice with Claude and returns lines for review. Secret: `ANTHROPIC_API_KEY_APPAREL`. Matching keys and fee spreading are in `spread.ts`, with copies in `index.html` that must stay identical.
  - `low-stock-alert`: emails every active admin when a stock change drops an item to its reorder point. Database triggers call it through pg_net, and it sends from the app's own dedicated Gmail account. Secrets: `GMAIL_ADDRESS_APPAREL`, `GMAIL_APP_PASSWORD_APPAREL`. Don't connect any other mail account.

## Data model (`apparel` schema)

- **`items`:** one row per SKU and size, with `unit_cost`, `reorder_threshold`, `active` and `is_test`.
- **`transactions`:** stock is the sum of `qty_change`. A checkout is negative, a receive positive, and an adjust is non-zero.
- **`inventory` view:** gives `on_hand` and `low_stock`, which is `on_hand <= reorder_threshold`. The app shows that flag as **Low**.
- **`invoices`:** every vendor document, not just invoices. `doc_type` is `packing_slip`, `invoice` or `other`.
  - A packing slip adds stock and never changes cost (`apparel.receive_packing_slip`).
  - An invoice adds no stock. It sets item cost to garment price plus logo charges (`apparel.apply_invoice_costs`), logged in `cost_updates`.
  - Set-up fees are never in item cost. They sit in `invoices.setup_fees` and are charged to the department with code `10` in the report.
- **`coding_reports`:** one per invoice, for accounting. Check outs not yet on a report fill the invoice total, oldest first. The rest is Stock Up, or carries to the next invoice. `transactions.report_id` marks which report a check out is on. All of it runs in `apparel.coding_report()`.
- **Other tables:** `departments`, `employees`, `cost_updates`, `vendor_aliases` and `low_stock_alerts` (the email queue and history).
- **`app_users`:** each user's role is `checkout` or `admin`.
  - Row-level security lets only active app users in.
  - Checkout users can read, add employees and record check outs.
  - Admins can do everything else.

## How changes go live

- **Page:** commit and push to `main`, but only when the owner says so. Afterwards, ask them to hard refresh (Cmd+Shift+R).
- **SQL:** the owner pastes the file into Supabase's SQL Editor and runs it.
- **Edge Functions:** the owner runs `supabase functions deploy <name> --no-verify-jwt` from the repo folder.
- **Secrets:** the owner runs `supabase secrets set NAME=value`. Secret values never go in files or chat.
- **Feature needing all three:** run the SQL first, then deploy the function, then push the page.

## Testing

- **No local Deno:** test pure logic with Node, for example `node supabase/functions/invoice-extract/spread.test.ts` and `node supabase/functions/low-stock-alert/message.test.ts`.
- **SQL:** an in-memory Postgres works (PGlite from npm, installed in a scratch folder), with stubs for Supabase's `auth` schema and `net.http_post`.
- **Sample documents:** `testing/test-packing-slip.pdf` and `testing/test-invoice.pdf`, rebuilt by `python3 testing/make_test_documents.py`.
- **Test mode** (Admin → Test mode) keeps test items, employees, departments and documents apart from real data. Use it to try a feature end to end. The Test Product (`TEST-S`, `TEST-M`, `TEST-L`) has a reorder point of 2.

## Working with the owner

The owner runs all the setup steps (SQL, deploys, secrets) themselves.
- Give one step at a time, with the exact clicks or command.
- Say what success looks like, and wait for confirmation before the next step.
- Keep explanations and costs in plain language.
