// Pure helpers for invoice-extract. No Deno or network APIs, so they can be
// tested with plain Node:  node spread.test.ts

/** Lower-case, single spaces, trimmed. The page uses the identical rule. */
export function normKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Key for a remembered vendor-line match. The part number alone is not enough:
 * one part number often covers every size and colour of a garment, so colour and
 * size are part of the key. The page builds the same key when it saves a match.
 */
export function aliasKey(sku: string | null | undefined, description: string | null | undefined, color?: string | null, size?: string | null): string {
  const base = normKey(sku) || normKey(description);
  if (!base) return "";
  return [base, normKey(color), normKey(size)].filter(Boolean).join(" | ");
}

export type AddOn = { description: string; kind: "decoration" | "setup"; amount: number };
export type SpreadInfo = { total: number; units: number; per_unit: number; charges: AddOn[] };

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Spread decoration and set-up charges equally over every product piece.
 * Returns the per-piece amount and each line's cost including its share.
 * Costs are stored to the cent, so each line is rounded and the lines can differ
 * from the invoice total by a few cents. Lines without a cost are left without one.
 */
export function spreadAddOns<L extends { qty: number; unit_cost: number | null }>(lines: L[], charges: AddOn[]): { spread: SpreadInfo | null; lines: (L & { base_unit_cost: number | null })[] } {
  const units = lines.reduce((t, l) => t + (Number.isFinite(l.qty) && l.qty > 0 ? Math.round(l.qty) : 0), 0);
  const total = round2(charges.reduce((t, c) => t + (Number.isFinite(c.amount) ? c.amount : 0), 0));
  const withBase = lines.map((l) => ({ ...l, base_unit_cost: l.unit_cost }));
  if (!units || total <= 0) return { spread: null, lines: withBase };
  const perUnit = total / units;
  return {
    spread: { total, units, per_unit: Math.round(perUnit * 1000) / 1000, charges },
    lines: withBase.map((l) => ({ ...l, unit_cost: l.unit_cost == null ? null : round2(l.unit_cost + perUnit) })),
  };
}
