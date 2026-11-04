// Pure helpers for invoice-extract. No Deno or network APIs, so they can be
// tested with plain Node:  node spread.test.ts
// The page (index.html) has copies of normKey, normVendor, normSize, normDesign,
// baseSku and aliasKey. Keep them identical, or remembered matches stop matching.

/** Lower-case, single spaces, trimmed. */
export function normKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A vendor's name without punctuation or company endings, so "Eugene Silkscreen, Inc." and "Eugene Silkscreen" agree. */
export function normVendor(s: string | null | undefined): string {
  let t = normKey(s).replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (let prev = ""; prev !== t; ) { prev = t; t = t.replace(/ (inc|incorporated|llc|ltd|limited|co|corp|corporation|company)$/, "").trim(); }
  return t;
}

const SIZE_WORDS: Record<string, string> = {
  s: "s", sm: "s", sml: "s", small: "s",
  m: "m", md: "m", med: "m", medium: "m",
  l: "l", lg: "l", lrg: "l", large: "l",
  xl: "xl", xlg: "xl", xlarge: "xl",
  "2x": "2xl", "2xl": "2xl", xxl: "2xl", "2xlarge": "2xl", xxlarge: "2xl",
  "3x": "3xl", "3xl": "3xl", xxxl: "3xl", "3xlarge": "3xl",
  "4x": "4xl", "4xl": "4xl", xxxxl: "4xl", "4xlarge": "4xl",
  "5x": "5xl", "5xl": "5xl",
  os: "os", osfa: "os", onesize: "os", onesizefitsall: "os",
};

/** One spelling per size, so "LG", "L" and "Large" or "4X" and "4XL" agree. Youth sizes keep a "y" prefix. */
export function normSize(s: string | null | undefined): string {
  let t = normKey(s).replace(/[\s.\-_]/g, "");
  if (!t) return "";
  let youth = "";
  const y = /^(youth|yth|y)(.+)$/.exec(t);
  if (y && Object.hasOwn(SIZE_WORDS, y[2])) { youth = "y"; t = y[2]; }
  return youth + (Object.hasOwn(SIZE_WORDS, t) ? SIZE_WORDS[t] : t);
}

/** The design's ID number when one is printed (e.g. "18054 Rexius Sprout 2021" -> "18054"), else its name. */
export function normDesign(s: string | null | undefined): string {
  const k = normKey(s);
  const id = /\d{3,}/.exec(k);
  return id ? id[0] : k;
}

/** The style or part number without a size tacked on the end ("2400_4X" with size 4X -> "2400"). */
export function baseSku(sku: string | null | undefined, size?: string | null): string {
  const s = normKey(sku);
  const want = normSize(size);
  if (!s || !want) return s;
  const m = /^(.+?)[\s_\-/.]+([a-z0-9]+)$/.exec(s);
  return m && normSize(m[2]) === want ? m[1] : s;
}

/**
 * Key for a remembered vendor-line match. One part number often covers every
 * size and colour, and the same blank shirt can carry different designs, so
 * colour, size and design are part of the key.
 */
export function aliasKey(sku: string | null | undefined, description: string | null | undefined, color?: string | null, size?: string | null, design?: string | null): string {
  const base = baseSku(sku, size) || normKey(description);
  if (!base) return "";
  return [base, normKey(color), normSize(size), normDesign(design)].filter(Boolean).join(" | ");
}

export type Charge = { description: string; kind: "decoration" | "setup"; amount: number; group?: string | null };
export type ChargeSummary = {
  decoration: Charge[]; setup: Charge[];
  decoration_total: number; setup_total: number;
  units: number;           // pieces the logo charges were spread over
  grouped: boolean;        // true when some charge applied to one section of the invoice only
  unassigned: number;      // logo charges with no pieces to go on (shown, not added to any cost)
};

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const pieces = (qty: number) => (Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 0);

/**
 * Adds logo (decoration) charges to garment costs, equally per piece.
 * A charge marked with a section (group) of the invoice goes on that section's
 * pieces only; otherwise it goes on every piece. Set-up fees are never added to
 * cost: they are totalled for the set-up fee report.
 * Costs are stored to the cent, so each line is rounded. Lines without a price stay without one.
 */
export function spreadCharges<L extends { qty: number; unit_cost: number | null; group?: string | null }>(lines: L[], charges: Charge[]) {
  const ok = (c: Charge) => Number.isFinite(c.amount);
  const decoration = charges.filter((c) => c.kind === "decoration" && ok(c));
  const setup = charges.filter((c) => c.kind === "setup" && ok(c));
  const all = lines.map((_, i) => i);
  const share = lines.map(() => 0);
  let grouped = false, unassigned = 0;
  for (const c of decoration) {
    let idx = c.group ? all.filter((i) => normKey(lines[i].group) === normKey(c.group)) : [];
    const groupUnits = idx.reduce((t, i) => t + pieces(lines[i].qty), 0);
    if (idx.length && groupUnits > 0) { if (idx.length < lines.length) grouped = true; } else idx = all;
    const units = idx.reduce((t, i) => t + pieces(lines[i].qty), 0);
    if (!units) { unassigned += c.amount; continue; }
    for (const i of idx) share[i] += c.amount / units;
  }
  const summary: ChargeSummary = {
    decoration, setup,
    decoration_total: round2(decoration.reduce((t, c) => t + c.amount, 0)),
    setup_total: round2(setup.reduce((t, c) => t + c.amount, 0)),
    units: lines.reduce((t, l) => t + pieces(l.qty), 0),
    grouped, unassigned: round2(unassigned),
  };
  return {
    summary,
    lines: lines.map((l, i) => ({
      ...l,
      base_unit_cost: l.unit_cost,
      decoration_per_unit: round3(share[i]),
      unit_cost: l.unit_cost == null ? null : round2(l.unit_cost + share[i]),
    })),
  };
}
