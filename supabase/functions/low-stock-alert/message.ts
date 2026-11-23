// Low-stock email grouping and wording for the low-stock-alert function.
//
// No imports, so it runs under plain Node for the tests:
//   node supabase/functions/low-stock-alert/message.test.ts

/** A queued alert, as apparel.claim_low_stock_alerts() returns it. */
export type Alert = {
  id: number;
  item_id: string;
  name: string;
  size: string | null;
  sku: string;
  on_hand: number;
  reorder_threshold: number;
  is_test: boolean;
  triggered_by: string | null;
  created_at: string;
  /** "low": rack and overflow together are at the reorder point. "refill": only the rack is, and overflow has more. Missing means "low". */
  kind?: "low" | "refill";
  /** How many of on_hand are boxed in overflow. */
  overflow?: number;
};

/** An app user, as apparel.admin_list_users() returns it. */
export type AppUser = {
  user_id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  active: boolean;
};

export type Message = { subject: string; text: string; html: string };
export type Email = Message & { ids: number[]; to: string[] };
export type Outcome = { ids: number[]; reason: string };
export type Plan = { emails: Email[]; skipped: Outcome[]; failed: Outcome[] };

export const TEST_NOTE = "This is a test alert from test mode, for a test item. Only you got it; real alerts go to every admin.";

/**
 * Splits the claimed alerts into emails. Real items: one email to every active
 * admin. Test items: one email per person who made the change, to them only.
 * Real alerts with no admin to send to fail (and are retried later); test
 * alerts with nobody to send to are skipped.
 */
export function planEmails(alerts: Alert[], users: AppUser[], appUrl: string): Plan {
  const plan: Plan = { emails: [], skipped: [], failed: [] };

  const real = alerts.filter((a) => !a.is_test);
  if (real.length) {
    const ids = real.map((a) => a.id);
    const to = adminAddresses(users);
    if (to.length) plan.emails.push({ ids, to, ...buildMessage(real, appUrl, false) });
    else plan.failed.push({ ids, reason: "There are no active admins with an email address to send it to." });
  }

  const testByPerson = new Map<string, Alert[]>();
  for (const a of alerts) {
    if (!a.is_test) continue;
    const key = a.triggered_by ?? "";
    const list = testByPerson.get(key);
    if (list) list.push(a);
    else testByPerson.set(key, [a]);
  }
  for (const [userId, list] of testByPerson) {
    const ids = list.map((a) => a.id);
    const email = userId ? (users.find((u) => u.user_id === userId && u.active)?.email ?? "").trim() : "";
    if (email) plan.emails.push({ ids, to: [email], ...buildMessage(list, appUrl, true) });
    else {
      plan.skipped.push({
        ids,
        reason: userId
          ? "Test alert: the person who made the change isn't an active app user with an email address."
          : "Test alert: the change wasn't made by a signed-in app user, so there was nobody to send it to.",
      });
    }
  }
  return plan;
}

/** Active admins' addresses, each once. */
export function adminAddresses(users: AppUser[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of users) {
    const email = (u.email ?? "").trim();
    if (!u.active || u.role !== "admin" || !email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push(email);
  }
  return out;
}

/** Subject, plain text and HTML for one email about these alerts. */
export function buildMessage(alerts: Alert[], appUrl: string, isTest: boolean): Message {
  const items = latestPerItem(alerts);
  return { subject: subjectFor(items, isTest), text: textBody(items, appUrl, isTest), html: htmlBody(items, appUrl, isTest) };
}

/** One line per item, in the order given. An item queued twice (a retry plus a new drop) shows its latest numbers. */
export function latestPerItem(alerts: Alert[]): Alert[] {
  const byItem = new Map<string, Alert>();
  for (const a of alerts) {
    const prev = byItem.get(a.item_id);
    if (!prev || a.id > prev.id) byItem.set(a.item_id, a);
  }
  return [...byItem.values()];
}

const itemName = (a: Alert) => (a.size ? `${a.name} ${a.size}` : a.name);
const overflowOf = (a: Alert) => a.overflow ?? 0;
const isRefill = (a: Alert) => a.kind === "refill";
const rackOf = (a: Alert) => a.on_hand - overflowOf(a);
const count = (n: number, word: string) => `${n} ${n === 1 ? word : word + "s"}`;

export function subjectFor(items: Alert[], isTest: boolean): string {
  const prefix = isTest ? "[TEST] " : "";
  const refill = items.filter(isRefill).length;
  const low = items.length - refill;
  if (items.length === 1) {
    const a = items[0];
    return refill
      ? `${prefix}Refill from overflow: ${itemName(a)} – ${rackOf(a)} on the rack, ${overflowOf(a)} in overflow`
      : `${prefix}Low stock: ${itemName(a)} – ${a.on_hand} left (reorder at ${a.reorder_threshold})`;
  }
  if (!refill) return `${prefix}Low stock: ${items.length} items at their reorder point`;
  if (!low) return `${prefix}Refill from overflow: ${refill} items low on the rack`;
  return `${prefix}Low stock: ${count(low, "item")} to reorder, ${refill} to refill from overflow`;
}

function intro(count: number): string {
  return count === 1 ? "This item is now at or below its reorder point:" : "These items are now at or below their reorder point:";
}

function refillIntro(count: number): string {
  return count === 1
    ? "This item is low on the rack, with more in overflow to bring over:"
    : "These items are low on the rack, with more in overflow to bring over:";
}

function footer(isTest: boolean): string {
  return isTest
    ? "Sent automatically by the Rexius Apparel app from test mode. Replies to this address aren't read."
    : "Sent automatically by the Rexius Apparel app to its admins. Replies to this address aren't read.";
}

export function textBody(items: Alert[], appUrl: string, isTest: boolean): string {
  const low = items.filter((a) => !isRefill(a));
  const refill = items.filter(isRefill);
  const lines: string[] = [];
  if (isTest) lines.push(TEST_NOTE, "");
  if (low.length) {
    lines.push(intro(low.length), "");
    for (const a of low) {
      const boxed = overflowOf(a) > 0 ? ` (${overflowOf(a)} of them in overflow)` : "";
      lines.push(`- ${itemName(a)} (${a.sku}): ${a.on_hand} on hand${boxed}, reorder at ${a.reorder_threshold}`);
    }
    lines.push("");
  }
  if (refill.length) {
    lines.push(refillIntro(refill.length), "");
    for (const a of refill) lines.push(`- ${itemName(a)} (${a.sku}): ${rackOf(a)} on the rack, ${overflowOf(a)} in overflow, refill at ${a.reorder_threshold}`);
    lines.push("");
  }
  lines.push(`Open the app: ${appUrl}`, "", footer(isTest));
  return lines.join("\n");
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Inline styles only, and plain tables, so it looks the same in Outlook and Gmail.
export function htmlBody(items: Alert[], appUrl: string, isTest: boolean): string {
  const th = "padding:6px 14px 6px 0;border-bottom:2px solid #4E4E50;font-weight:bold;";
  const td = "padding:6px 14px 6px 0;border-bottom:1px solid #CCD3CD;";
  const head = (label: string, align: string) => `<th align="${align}" style="${th}text-align:${align};">${label}</th>`;
  const cell = (value: string, align: string, bold = false) =>
    `<td align="${align}" style="${td}text-align:${align};">${bold ? `<strong>${esc(value)}</strong>` : esc(value)}</td>`;
  const table = (heads: string, rows: string) =>
    `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:14px;">
<tr>${heads}</tr>
${rows}
</table>`;
  const item = (a: Alert) => `${cell(a.name, "left")}${cell(a.size ?? "", "left")}${cell(a.sku, "left")}`;
  const itemHeads = `${head("Item", "left")}${head("Size", "left")}${head("SKU", "left")}`;
  const sections: string[] = [];

  const low = items.filter((a) => !isRefill(a));
  if (low.length) {
    // The overflow column only shows when one of these items has some boxed up.
    const boxed = low.some((a) => overflowOf(a) > 0);
    const rows = low
      .map((a) => `<tr>${item(a)}${cell(String(a.on_hand), "right", true)}${boxed ? cell(String(overflowOf(a)), "right") : ""}${cell(String(a.reorder_threshold), "right")}</tr>`)
      .join("\n");
    sections.push(`<p style="margin:0 0 12px;">${esc(intro(low.length))}</p>
${table(`${itemHeads}${head("On hand", "right")}${boxed ? head("Of those, in overflow", "right") : ""}${head("Reorder at", "right")}`, rows)}`);
  }

  const refill = items.filter(isRefill);
  if (refill.length) {
    const rows = refill
      .map((a) => `<tr>${item(a)}${cell(String(rackOf(a)), "right", true)}${cell(String(overflowOf(a)), "right")}${cell(String(a.reorder_threshold), "right")}</tr>`)
      .join("\n");
    sections.push(`<p style="margin:${low.length ? "20px" : "0"} 0 12px;">${esc(refillIntro(refill.length))}</p>
${table(`${itemHeads}${head("On the rack", "right")}${head("In overflow", "right")}${head("Refill at", "right")}`, rows)}`);
  }

  return `<!doctype html>
<html><body style="margin:0;padding:16px;background:#FFFFFF;color:#2A2D2C;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;">
${isTest ? `<p style="margin:0 0 12px;padding:8px 12px;background:#FCEBDD;border-left:4px solid #E4621B;">${esc(TEST_NOTE)}</p>\n` : ""}${sections.join("\n")}
<p style="margin:16px 0;"><a href="${esc(appUrl)}" style="color:#3C7235;font-weight:bold;">Open Rexius Apparel</a></p>
<p style="margin:16px 0 0;color:#6F7572;font-size:12px;">${esc(footer(isTest))}</p>
</body></html>`;
}
