import assert from "node:assert/strict";
import { adminAddresses, buildMessage, esc, latestPerItem, planEmails, TEST_NOTE, type Alert, type AppUser } from "./message.ts";

const APP = "https://rexiusfleet.github.io/rexius-apparel/";
const alert = (o: Partial<Alert>): Alert => ({
  id: 1, item_id: "item-1", name: "High-Vis T-Shirt - Short Sleeve", size: "L", sku: "HV-SS-L",
  on_hand: 4, reorder_threshold: 5, is_test: false, triggered_by: "u-casey", created_at: "2026-11-02T15:00:00Z", ...o,
});
const users: AppUser[] = [
  { user_id: "u-andy", email: "andy@example.com", display_name: "Andy", role: "admin", active: true },
  { user_id: "u-jo", email: " Jo@Example.com ", display_name: "Jo", role: "admin", active: true },
  { user_id: "u-jo2", email: "jo@example.com", display_name: "Jo again", role: "admin", active: true },
  { user_id: "u-old", email: "old@example.com", display_name: "Old admin", role: "admin", active: false },
  { user_id: "u-noemail", email: null, display_name: "No email", role: "admin", active: true },
  { user_id: "u-casey", email: "casey@example.com", display_name: "Casey", role: "checkout", active: true },
];

// Recipients: active admins with an address, each once, never checkout users or inactive admins.
assert.deepEqual(adminAddresses(users), ["andy@example.com", "Jo@Example.com"]);

// One real item: one email to the admins, with the numbers in the subject.
let plan = planEmails([alert({})], users, APP);
assert.equal(plan.emails.length, 1);
assert.deepEqual(plan.emails[0].ids, [1]);
assert.deepEqual(plan.emails[0].to, ["andy@example.com", "Jo@Example.com"]);
assert.equal(plan.emails[0].subject, "Low stock: High-Vis T-Shirt - Short Sleeve L – 4 left (reorder at 5)");
assert.match(plan.emails[0].text, /^This item is now at or below its reorder point:\n\n- High-Vis T-Shirt - Short Sleeve L \(HV-SS-L\): 4 on hand, reorder at 5\n\nOpen the app: https:\/\/rexiusfleet\.github\.io\/rexius-apparel\/\n\nSent automatically by the Rexius Apparel app to its admins\. Replies to this address aren't read\.$/);
assert.ok(plan.emails[0].html.includes('<a href="https://rexiusfleet.github.io/rexius-apparel/"'));
assert.ok(!plan.emails[0].html.includes(TEST_NOTE) && !plan.emails[0].text.includes(TEST_NOTE));
assert.deepEqual(plan.skipped, []);
assert.deepEqual(plan.failed, []);

// No size: the subject leaves it out, and the HTML size cell is empty.
assert.equal(buildMessage([alert({ name: "Ball Cap", size: null, sku: "HV-CAP", on_hand: 0, reorder_threshold: 2 })], APP, false).subject,
  "Low stock: Ball Cap – 0 left (reorder at 2)");

// A check out that took several items down: one email listing them all, in the order given.
plan = planEmails([alert({ id: 7 }), alert({ id: 8, item_id: "item-2", size: "XL", sku: "HV-SS-XL", on_hand: 2, reorder_threshold: 3 })], users, APP);
assert.equal(plan.emails.length, 1);
assert.deepEqual(plan.emails[0].ids, [7, 8]);
assert.equal(plan.emails[0].subject, "Low stock: 2 items at their reorder point");
assert.ok(plan.emails[0].text.startsWith("These items are now at or below their reorder point:\n\n- High-Vis T-Shirt - Short Sleeve L (HV-SS-L): 4 on hand, reorder at 5\n- High-Vis T-Shirt - Short Sleeve XL (HV-SS-XL): 2 on hand, reorder at 3\n"));
assert.equal(plan.emails[0].html.match(/<tr>/g)?.length, 3);   // header + 2 items

// An item queued twice (a failed alert retried with a new drop) is listed once, with the latest numbers.
const twice = latestPerItem([alert({ id: 3, on_hand: 5 }), alert({ id: 9, on_hand: 1 }), alert({ id: 4, item_id: "item-2" })]);
assert.deepEqual(twice.map((a) => a.id), [9, 4]);
plan = planEmails([alert({ id: 3, on_hand: 5 }), alert({ id: 9, on_hand: 1 })], users, APP);
assert.deepEqual(plan.emails[0].ids, [3, 9]);   // both rows are marked sent
assert.equal(plan.emails[0].subject, "Low stock: High-Vis T-Shirt - Short Sleeve L – 1 left (reorder at 5)");

// Test items go only to the person who made the change, marked [TEST]; real ones still go to every admin.
plan = planEmails([
  alert({ id: 20 }),
  alert({ id: 21, item_id: "t-s", name: "Test Product", size: "S", sku: "TEST-S", on_hand: 2, reorder_threshold: 2, is_test: true, triggered_by: "u-andy" }),
  alert({ id: 22, item_id: "t-m", name: "Test Product", size: "M", sku: "TEST-M", on_hand: 1, reorder_threshold: 2, is_test: true, triggered_by: "u-andy" }),
], users, APP);
assert.equal(plan.emails.length, 2);
assert.deepEqual(plan.emails[0].ids, [20]);
assert.deepEqual(plan.emails[0].to, ["andy@example.com", "Jo@Example.com"]);
assert.deepEqual(plan.emails[1].ids, [21, 22]);
assert.deepEqual(plan.emails[1].to, ["andy@example.com"]);
assert.equal(plan.emails[1].subject, "[TEST] Low stock: 2 items at their reorder point");
assert.ok(plan.emails[1].text.startsWith(TEST_NOTE + "\n\n"));
assert.ok(plan.emails[1].text.endsWith("Sent automatically by the Rexius Apparel app from test mode. Replies to this address aren't read."));
assert.ok(plan.emails[1].html.includes(TEST_NOTE.replace("'", "&#39;")));
assert.equal(planEmails([alert({ is_test: true, triggered_by: "u-andy" })], users, APP).emails[0].subject,
  "[TEST] Low stock: High-Vis T-Shirt - Short Sleeve L – 4 left (reorder at 5)");

// Nobody to send to: real alerts fail (retried later), test alerts are skipped.
plan = planEmails([
  alert({ id: 30 }),
  alert({ id: 31, is_test: true, triggered_by: "u-old" }),
  alert({ id: 32, is_test: true, triggered_by: null }),
  alert({ id: 33, is_test: true, triggered_by: "u-noemail" }),
], users.filter((u) => u.role !== "admin" || !u.active || !u.email), APP);
assert.deepEqual(plan.emails, []);
assert.deepEqual(plan.failed.map((f) => f.ids), [[30]]);
assert.match(plan.failed[0].reason, /no active admins/);
assert.deepEqual(plan.skipped.map((s) => s.ids), [[31], [32], [33]]);   // one per person
assert.ok(plan.skipped.every((s) => s.reason.startsWith("Test alert:")));
assert.match(plan.skipped[1].reason, /signed-in/);
assert.deepEqual(planEmails([], users, APP), { emails: [], skipped: [], failed: [] });

// Everything from the database is escaped in the HTML.
assert.equal(esc(`<b>"Tom's" & co</b>`), "&lt;b&gt;&quot;Tom&#39;s&quot; &amp; co&lt;/b&gt;");
const nasty = buildMessage([alert({ name: "<script>x</script>", size: "M&L", sku: 'A"B' })], `https://example.com/?a=1&b="2"`, false);
assert.ok(!nasty.html.includes("<script>"));
assert.ok(nasty.html.includes("&lt;script&gt;x&lt;/script&gt;") && nasty.html.includes("M&amp;L") && nasty.html.includes("A&quot;B"));
assert.ok(nasty.html.includes('href="https://example.com/?a=1&amp;b=&quot;2&quot;"'));
assert.ok(nasty.text.includes("<script>x</script> M&L (A\"B)"));   // plain text stays as typed

console.log("message tests passed");
