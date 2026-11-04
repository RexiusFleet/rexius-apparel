// Rexius Apparel — invoice-extract Edge Function
//
// Reads a vendor document (PDF or photo already uploaded to the private
// "apparel-invoices" bucket) with Claude and returns its header and one row
// per garment and size, each matched to one of our items where it can. The
// document's type comes from its apparel.invoices row (doc_type):
//
//   packing_slip  what actually arrived. The page receives these quantities
//                 into stock (apparel.receive_packing_slip). No costs.
//   invoice       what it cost. The page sets each item's current cost to the
//                 garment price plus its share of logo (decoration) charges
//                 (apparel.apply_invoice_costs). Set-up fees are totalled
//                 separately for the department 10 set-up fee report. No stock.
//
// Request:  POST /functions/v1/invoice-extract
//           Authorization: Bearer <caller's Supabase access token>
//           apikey: <anon key>
//           body: { "invoice_id": "<uuid of apparel.invoices row>",
//                   "include_test": false }
//
// include_test is the page's test mode: true matches against the test items
// (items.is_test) only, false (the default) against the real items only, so a
// real document never lands on a test item and vice versa.
//
// Response: {
//   doc_type: "packing_slip" | "invoice" | "other",          (what we asked for)
//   header: { document_type, vendor, invoice_no, order_no, date, subtotal, total },
//   lines: [{ description, vendor_sku, color, size, design, group, qty, qty_ordered,
//             unit_cost, base_unit_cost, decoration_per_unit, line_total,
//             item_id, match: "alias" | "suggested" | "none",
//             confidence: "high" | "medium" | "low" | "none", note }],
//   charges: { decoration, setup, decoration_total, setup_total, units, grouped, unassigned },
//   other_charges: [{ description, amount }],
//   notes: string
// }
//
// Matching order: a saved vendor alias (apparel.vendor_aliases) always wins;
// otherwise the model's best guess from the item catalog is returned as a
// suggestion for the person to confirm on the review screen. Nothing is
// written to the database here — the page does that after review.
//
// Secrets: ANTHROPIC_API_KEY_APPAREL (set with `supabase secrets set`), plus the
// SUPABASE_* variables Supabase injects. Deployed with gateway JWT
// verification off (supabase/config.toml); the function verifies the token
// itself and requires an active admin.

import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk@1.3.0/helpers/zod";
import { z } from "npm:zod@3.25.76/v4";
import { aliasKey, normVendor, spreadCharges } from "./spread.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY_APPAREL = Deno.env.get("ANTHROPIC_API_KEY_APPAREL") ?? "";

const BUCKET = "apparel-invoices";
const MODEL = "claude-opus-5-5";
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set<string>([
  "https://rexiusfleet.github.io",
  ...(Deno.env.get("APPAREL_EXTRA_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const adminOpts = { ...noSession, db: { schema: "apparel" } };

async function requireCaller(req: Request): Promise<User> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("Authorization") ?? "");
  if (!m) throw new HttpError(401, "Missing Authorization: Bearer <access token> header.");
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, noSession);
  const { data, error } = await anon.auth.getUser(m[1].trim());
  if (error || !data?.user) throw new HttpError(401, "Your session is invalid or has expired. Sign in again.");
  return data.user;
}

async function requireActiveAdmin(admin: SupabaseClient, user: User): Promise<void> {
  const { data, error } = await admin.from("app_users").select("role, active").eq("user_id", user.id).maybeSingle();
  if (error) throw new HttpError(500, `Couldn't read apparel.app_users: ${error.message}`);
  if (!data || !data.active || data.role !== "admin") throw new HttpError(403, "Only active apparel admins can read invoices.");
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// What we ask Claude for
// ---------------------------------------------------------------------------

// The API allows at most 16 union-typed properties (nullable fields count) in an
// output schema. So text fields are plain strings with "" for "none", turned back
// into null by blankToNull() below, and only the numbers are nullable (5 now).
const Line = z.object({
  description: z.string().describe("The line's description exactly as printed, trimmed."),
  vendor_sku: z.string().describe("The vendor's style or part number for the garment WITHOUT any size suffix (print '2400_4X' -> '2400'), or \"\" if none is printed."),
  color: z.string().describe("The garment colour as printed (e.g. Safety Green), or \"\"."),
  size: z.string().describe("The garment size for THIS entry as printed (S, M, LG, XL, 2X, 4X, Youth M, etc.), or \"\" if the line has no size."),
  design: z.string().describe("The design printed or embroidered on this garment: its design ID number if one is shown (e.g. '18054'), otherwise the design name. If the document lists one design for everything, use it on every line. \"\" if none is shown."),
  group: z.string().describe("When an invoice is split into sections for separate orders, designs or ship-tos, a short label for this line's section (the order number or design ID). \"\" when the document has one section."),
  qty: z.number().describe("Pieces on this entry. Packing slip: the quantity actually shipped/received. Invoice: the quantity billed. Handwritten corrections override the printed number."),
  qty_ordered: z.number().nullable().describe("Packing slips only: the quantity ordered, when it is printed or shown and differs from qty (backorder, short shipment, handwritten correction). Otherwise null."),
  unit_cost: z.number().nullable().describe("Invoice: garment price per piece after line discounts, excluding decoration, set-up, tax and freight. Packing slip: null unless a price is printed."),
  line_total: z.number().nullable().describe("Extended total for the line as printed, or null."),
  item_id: z.string().describe("The id of the catalog item this line is, or \"\" if no catalog item plausibly matches. Match on product, class/type, colour and SIZE — size must match exactly."),
  confidence: z.enum(["high", "medium", "low", "none"]).describe("How sure you are about item_id. 'none' when item_id is \"\"."),
  note: z.string().describe("Anything the reviewer should know: a handwritten correction (say what was printed and what was written), a short shipment, pack conversions, ambiguity, a size we don't stock. \"\" if nothing."),
});

const Extraction = z.object({
  document_type: z.enum(["invoice", "packing_slip", "other"]).describe("What this document actually is. A packing list / packing slip / delivery note lists what shipped; an invoice bills for it."),
  vendor: z.string().describe("The vendor / seller name as printed (the company that sent the goods, not the customer)."),
  invoice_no: z.string().describe("The invoice number, or \"\" if this is not an invoice or none is printed."),
  order_no: z.string().describe("The vendor's order / sales order / job number, or \"\" if none is printed."),
  date: z.string().describe("YYYY-MM-DD. Invoice: the invoice date. Packing slip: the ship date, else the date printed on it. \"\" if none."),
  subtotal: z.number().nullable(),
  total: z.number().nullable().describe("Grand total due as printed, or null (packing slips usually have none)."),
  lines: z.array(Line).describe("One entry per garment/product and size. Do not include decoration, set-up, freight, shipping, tax, discounts, deposits or payment lines here."),
  add_on_charges: z.array(z.object({
    description: z.string().describe("The charge's description as printed."),
    kind: z.enum(["decoration", "setup"]).describe("decoration = a per-piece or per-job charge for putting a logo on garments: screen printing, embroidery, heat transfer, patches, logo charges. setup = one-time screen, set-up, art, digitizing, film, reorder or reset fees."),
    amount: z.number().describe("The EXTENDED total printed for the charge (the Total Price column), not the per-piece rate."),
    group: z.string().describe("The section label (as in lines[].group) this charge belongs to, or \"\" if it applies to the whole document."),
  })).describe("Decoration and set-up charges billed as their own lines. They are not stock items."),
  other_charges: z.array(z.object({ description: z.string(), amount: z.number() })).describe("Freight, shipping, handling, tax and any other non-product amounts that are NOT decoration or set-up charges."),
  notes: z.string().describe("General remarks about the document (poor photo, multiple pages, handwriting, credit memo, etc.), or \"\"."),
});
type ExtractionT = z.infer<typeof Extraction>;

/** "" (and whitespace) back to null, so the page sees the same shape as before. */
const blankToNull = (s: string | null | undefined): string | null => (typeof s === "string" && s.trim() !== "" ? s.trim() : null);

type Item = { id: string; name: string; size: string | null; sku: string | null; category: string | null; active: boolean; is_test: boolean };
type Alias = { vendor_key: string; alias_key: string; item_id: string };
type DocType = "invoice" | "packing_slip" | "other";

function systemPrompt(items: Item[], docType: DocType): string {
  const catalog = items.map((i) => ({ id: i.id, name: i.name, size: i.size ?? "", sku: i.sku ?? "", category: i.category ?? "" }));
  const purpose = docType === "packing_slip"
    ? "This document was filed as a PACKING SLIP. What you report as qty is added to stock, so it must be what physically arrived."
    : docType === "invoice"
      ? "This document was filed as an INVOICE. It adds no stock. Its garment prices and logo charges set each item's current cost."
      : "This document was filed as 'other'. Extract what you can.";
  return [
    "You read apparel vendor documents (packing slips and invoices) for an internal inventory app and return structured data for a person to review before anything is recorded.",
    "The company stocks branded high-visibility work apparel in multiple sizes. Each size is a separate catalog item. The same blank garment can be printed with different designs, which are different catalog items.",
    purpose,
    "",
    "Rules:",
    "- Return every garment line, in the order printed. Skip nothing, invent nothing.",
    "- Set document_type to what the paper actually is, even if it was filed as something else.",
    "- Handwriting: documents are often marked up by hand when the box is checked in. A handwritten number written beside, over or instead of a printed quantity (often with the printed one circled or crossed out) is the real quantity: use it for qty, and put the printed number in qty_ordered and in note. A crossed-out printed size or column header with a handwritten replacement means the handwritten size. Say in note whenever handwriting changed something.",
    "- Size grids: some documents print one row per garment with a grid of size columns and the quantity under the size. Return one entry per size that has a quantity, with that size in `size`, the colour in `color`, and the same unit cost. The description or part number often repeats the size (e.g. '4X' or a '_4X' suffix); trust it when the grid is unclear. If a grid has both Youth and Adult sizes and you cannot tell which the quantity sits under, assume Adult unless the description says youth, and say so in note.",
    "- Quantities are individual pieces. If a line is priced per pack/case/dozen and the pack size is shown, convert to pieces and per-piece cost and explain in note. If the pack size is not shown, leave qty as printed and flag it in note.",
    "- unit_cost is the garment price per piece after line discounts, without decoration, set-up, tax or freight. Use the extended total divided by pieces when the printed unit price disagrees with the extension.",
    "- Decoration and set-up: screen printing, embroidery, logos, patches, heat transfers, digitizing, screen or set-up fees and reorder/reset fees are not products. Put them in add_on_charges with the printed extended total, never in lines. Do not spread or allocate them yourself; the app does that.",
    "- If an invoice is split into sections (separate orders, designs or ship-tos), label each line's and each charge's section in `group` so logo charges stay with their own garments. Otherwise leave group empty.",
    "- Freight, shipping, handling and tax go in other_charges.",
    "- Match each line to a catalog item only when product, design (when the catalog distinguishes it) AND size clearly agree. Vendor wording differs from ours (abbreviations, part numbers, colour codes, '4X' for '4XL', 'LG' for 'L'); use judgement on the product but never on the size. If the size is not in the catalog, leave item_id empty and say in note which size.",
    "- Ignore shipping addresses and carriers; they do not matter here.",
    "- Dates are YYYY-MM-DD.",
    "- Text fields with nothing to report are \"\" (empty), never made up.",
    "",
    "Catalog (JSON, one object per item):",
    JSON.stringify(catalog),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function extract(admin: SupabaseClient, invoiceId: string, includeTest: boolean) {
  const { data: inv, error: invErr } = await admin.from("invoices").select("id, vendor, doc_type, file_path, file_name, content_type, size_bytes").eq("id", invoiceId).maybeSingle();
  if (invErr) throw new HttpError(500, `Couldn't read the document: ${invErr.message}`);
  if (!inv) throw new HttpError(404, "That document doesn't exist.");
  const docType: DocType = inv.doc_type === "packing_slip" || inv.doc_type === "other" ? inv.doc_type : "invoice";
  if ((inv.size_bytes ?? 0) > MAX_FILE_BYTES) throw new HttpError(413, "That file is over 20 MB. Re-scan at a lower resolution or split it.");

  const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(inv.file_path);
  if (dlErr || !blob) throw new HttpError(500, `Couldn't download the file: ${dlErr?.message ?? "no data"}`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, "That file is over 20 MB. Re-scan at a lower resolution or split it.");

  const mime = (inv.content_type || blob.type || "").toLowerCase();
  const name = (inv.file_name || "").toLowerCase();
  let media: Anthropic.ContentBlockParam;
  if (mime === "application/pdf" || name.endsWith(".pdf")) {
    media = { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytesToBase64(bytes) }, title: inv.file_name || "Document" };
  } else if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime)) {
    media = { type: "image", source: { type: "base64", media_type: mime as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data: bytesToBase64(bytes) } };
  } else if (mime === "image/heic" || mime === "image/heif" || name.endsWith(".heic")) {
    throw new HttpError(415, "HEIC photos can't be read yet. Take the photo again with the camera set to 'Most compatible', or save it as JPEG or PDF first.");
  } else {
    throw new HttpError(415, `Unsupported file type (${mime || "unknown"}). Use a PDF, JPEG or PNG.`);
  }

  const [{ data: items, error: itErr }, { data: aliases, error: alErr }] = await Promise.all([
    admin.from("items").select("id, name, size, sku, category, active, is_test").eq("active", true).eq("is_test", includeTest).order("name").order("size"),
    admin.from("vendor_aliases").select("vendor_key, alias_key, item_id"),
  ]);
  if (itErr) throw new HttpError(500, `Couldn't load items: ${itErr.message}`);
  if (alErr) throw new HttpError(500, `Couldn't load vendor matches: ${alErr.message}`);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY_APPAREL });
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "high", format: zodOutputFormat(Extraction) },
    system: systemPrompt((items ?? []) as Item[], docType),
    messages: [{
      role: "user",
      content: [
        media,
        { type: "text", text: `Extract this ${docType === "packing_slip" ? "packing slip" : docType === "invoice" ? "invoice" : "document"}${inv.vendor && inv.vendor !== "Unknown vendor" ? ` (we filed it under vendor "${inv.vendor}")` : ""}.` },
      ],
    }],
  });

  if (response.stop_reason === "refusal") throw new HttpError(422, "The document couldn't be processed. Try a clearer scan.");
  if (response.stop_reason === "max_tokens") throw new HttpError(422, "The document is too long to read in one go. Split it into smaller files.");
  const raw = response.parsed_output as ExtractionT | null;
  if (!raw) throw new HttpError(502, "Claude returned an unreadable answer. Try again.");
  const parsed = {
    ...raw,
    invoice_no: blankToNull(raw.invoice_no), order_no: blankToNull(raw.order_no), date: blankToNull(raw.date), notes: blankToNull(raw.notes),
    lines: raw.lines.map((l) => ({ ...l, vendor_sku: blankToNull(l.vendor_sku), color: blankToNull(l.color), size: blankToNull(l.size), design: blankToNull(l.design),
      group: blankToNull(l.group), item_id: blankToNull(l.item_id), note: blankToNull(l.note) })),
    add_on_charges: (raw.add_on_charges ?? []).map((c) => ({ ...c, group: blankToNull(c.group) })),
  };

  // Saved matches win over the model's guesses.
  const itemIds = new Set((items ?? []).map((i: Item) => i.id));
  const vendorKey = normVendor(parsed.vendor) || normVendor(inv.vendor);
  const aliasMap = new Map<string, string>();
  for (const a of (aliases ?? []) as Alias[]) aliasMap.set(`${a.vendor_key}\u0000${a.alias_key}`, a.item_id);
  const lookup = (vk: string, key: string) => (key ? aliasMap.get(`${vk}\u0000${key}`) : undefined);

  const matched = parsed.lines.map((l) => {
    const bySku = aliasKey(l.vendor_sku, null, l.color, l.size, l.design), byDesc = aliasKey(null, l.description, l.color, l.size, l.design);
    const aliasHit = lookup(vendorKey, bySku) ?? lookup(vendorKey, byDesc) ?? lookup(normVendor(inv.vendor), bySku) ?? lookup(normVendor(inv.vendor), byDesc);
    if (aliasHit && itemIds.has(aliasHit)) return { ...l, item_id: aliasHit, match: "alias" as const, confidence: "high" as const };
    const suggested = l.item_id && itemIds.has(l.item_id) ? l.item_id : null;
    return { ...l, item_id: suggested, match: suggested ? ("suggested" as const) : ("none" as const), confidence: suggested ? l.confidence : ("none" as const) };
  });
  const { summary, lines } = spreadCharges(matched, parsed.add_on_charges ?? []);

  return {
    doc_type: docType,
    header: { document_type: parsed.document_type, vendor: parsed.vendor, invoice_no: parsed.invoice_no, order_no: parsed.order_no, date: parsed.date, subtotal: parsed.subtotal, total: parsed.total },
    lines,
    charges: summary,
    other_charges: parsed.other_charges,
    notes: parsed.notes,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, model: response.model },
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

  try {
    if (origin && !ALLOWED_ORIGINS.has(origin)) throw new HttpError(403, "Origin not allowed.");
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) throw new HttpError(500, "Function is missing its SUPABASE_* environment variables.");
    if (!ANTHROPIC_API_KEY_APPAREL) throw new HttpError(500, "ANTHROPIC_API_KEY_APPAREL isn't set. Add it with: supabase secrets set ANTHROPIC_API_KEY_APPAREL=...");

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; } catch { throw new HttpError(400, "Body must be JSON."); }
    const invoiceId = typeof body?.invoice_id === "string" ? body.invoice_id.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invoiceId)) throw new HttpError(400, "invoice_id must be a UUID.");
    const includeTest = body?.include_test === true;

    const caller = await requireCaller(req);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, adminOpts);
    await requireActiveAdmin(admin, caller);

    return json(await extract(admin, invoiceId, includeTest), 200, origin);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status, origin);
    if (e instanceof Anthropic.APIError) {
      console.error("invoice-extract Claude API error", e.status, e.message);
      return json({ error: `Claude API error (${e.status}): ${e.message}` }, 502, origin);
    }
    if (e instanceof Anthropic.AnthropicError) {
      // Not an HTTP error: the reply came back but didn't fit the expected shape.
      console.error("invoice-extract unreadable reply", e.message.slice(0, 500));
      return json({ error: "Claude's answer didn't come back in the expected form. Try again." }, 502, origin);
    }
    console.error("invoice-extract unexpected error", e);
    return json({ error: `Unexpected error (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}). This is only shown to signed-in admins.` }, 500, origin);
  }
});
