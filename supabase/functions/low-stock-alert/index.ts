// Rexius Apparel — low-stock-alert Edge Function
//
// Emails the apparel app's admins when an item drops to its reorder point.
//
// The database does the noticing. Triggers on apparel.transactions queue a
// row in apparel.low_stock_alerts for every item a stock change takes from
// above its reorder point to at or below it, then call this function through
// pg_net (supabase/migrations/20261102210000_low_stock_alerts.sql). The call
// carries nothing: the function claims whatever is due in that queue, sends
// it and records the outcome on each row. A stray call can't send anything
// that isn't already due, so there is no caller authentication.
//
// Request:  POST /functions/v1/low-stock-alert   (the body is ignored)
// Response: { claimed, sent, failed, skipped }   (numbers of alert rows)
//
// Who gets what (message.ts has the grouping and the wording):
//   real items  one email to every active admin, listing everything due
//   test items  one email to the person who made the change, with [TEST] in
//               the subject; nobody else
//
// An alert whose email fails is marked failed with the error and is tried
// again on a later call (up to 5 tries, within a day of the drop).
//
// Mail goes out through Gmail (smtp.gmail.com, port 465, TLS) from the app's
// own Gmail account; Supabase blocks outgoing ports 25 and 587, not 465.
// Secrets, set with `supabase secrets set`:
//   GMAIL_ADDRESS_APPAREL       the Gmail address the alerts come from
//   GMAIL_APP_PASSWORD_APPAREL  a Google app password for that account
//                               (16 letters; any spaces are removed)
//   APPAREL_APP_URL             optional: the app link in the email
// plus SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, which Supabase injects.
//
// Deployed with gateway JWT verification off (supabase/config.toml), because
// the caller is the database, which has no user token to send.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import nodemailer from "npm:nodemailer@9.1.1";
import { planEmails, type Alert, type AppUser } from "./message.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GMAIL_ADDRESS = (Deno.env.get("GMAIL_ADDRESS_APPAREL") ?? "").trim();
// Google shows an app password as four groups of four letters; the spaces aren't part of it.
const GMAIL_APP_PASSWORD = (Deno.env.get("GMAIL_APP_PASSWORD_APPAREL") ?? "").replace(/\s+/g, "");
const APP_URL = (Deno.env.get("APPAREL_APP_URL") ?? "").trim() || "https://rexiusfleet.github.io/rexius-apparel/";

const FROM_NAME = "Rexius Apparel";
const MAX_ERROR_LENGTH = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function errorText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.length > MAX_ERROR_LENGTH ? s.slice(0, MAX_ERROR_LENGTH - 1) + "…" : s;
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
// The service-role client talks to the "apparel" schema (tables live there, not in public).
const adminOpts = { ...noSession, db: { schema: "apparel" } };

/** Records what happened to some alert rows. A failure here is only logged: the email has gone (or not) either way. */
async function record(admin: SupabaseClient, ids: number[], patch: Record<string, unknown>) {
  const { error } = await admin.from("low_stock_alerts").update(patch).in("id", ids);
  if (error) console.error("low-stock-alert couldn't record the outcome", ids, error.message);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function sendDue(admin: SupabaseClient) {
  const { data: claimed, error: claimErr } = await admin.rpc("claim_low_stock_alerts");
  if (claimErr) {
    throw new HttpError(500, `Couldn't claim the queued alerts: ${claimErr.message}. Has the low_stock_alerts migration been run?`);
  }
  const alerts = (claimed ?? []) as Alert[];
  const counts = { claimed: alerts.length, sent: 0, failed: 0, skipped: 0 };
  if (!alerts.length) return counts;

  // Every claimed row now has to end up sent, failed or skipped. One left as
  // "sending" waits 10 minutes before a later call picks it up again.
  const { data: users, error: usersErr } = await admin.rpc("admin_list_users");
  if (usersErr) {
    const message = `Couldn't list the app's users: ${usersErr.message}`;
    await record(admin, alerts.map((a) => a.id), { status: "failed", error: errorText(message) });
    throw new HttpError(500, message);
  }

  const plan = planEmails(alerts, (users ?? []) as AppUser[], APP_URL);
  for (const f of plan.failed) {
    await record(admin, f.ids, { status: "failed", error: f.reason });
    counts.failed += f.ids.length;
  }
  for (const s of plan.skipped) {
    await record(admin, s.ids, { status: "skipped", error: s.reason });
    counts.skipped += s.ids.length;
  }
  if (!plan.emails.length) return counts;

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_ADDRESS, pass: GMAIL_APP_PASSWORD },
    // Give up well inside the function's time limit, so the row records why.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    for (const email of plan.emails) {
      try {
        await transport.sendMail({
          from: { name: FROM_NAME, address: GMAIL_ADDRESS },
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
        });
        await record(admin, email.ids, { status: "sent", sent_at: new Date().toISOString(), sent_to: email.to.join(", "), error: null });
        counts.sent += email.ids.length;
      } catch (e) {
        console.error("low-stock-alert send failed", errorText(e));
        await record(admin, email.ids, { status: "failed", error: errorText(e) });
        counts.failed += email.ids.length;
      }
    }
  } finally {
    transport.close();
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new HttpError(500, "Function is missing its SUPABASE_* environment variables.");
    // Checked before anything is claimed, so the alerts stay queued until the secrets are in.
    if (!GMAIL_ADDRESS || !GMAIL_APP_PASSWORD) {
      throw new HttpError(500, 'GMAIL_ADDRESS_APPAREL and GMAIL_APP_PASSWORD_APPAREL must both be set. Add them with: supabase secrets set GMAIL_ADDRESS_APPAREL=... GMAIL_APP_PASSWORD_APPAREL="..."');
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, adminOpts);
    const result = await sendDue(admin);
    if (result.claimed) console.log("low-stock-alert", JSON.stringify(result));
    return json(result, 200);
  } catch (e) {
    if (e instanceof HttpError) {
      console.error("low-stock-alert", e.message);
      return json({ error: e.message }, e.status);
    }
    // Anyone can call this address, so unexpected details stay in the logs.
    console.error("low-stock-alert unexpected error", e);
    return json({ error: "Unexpected error. Check the function logs." }, 500);
  }
});
