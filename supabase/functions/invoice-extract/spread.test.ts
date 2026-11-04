import assert from "node:assert/strict";
import { aliasKey, baseSku, normDesign, normSize, normVendor, round2, spreadCharges, type Charge } from "./spread.ts";

// Invoice 66123: 25 tees at 9.35 and 15 hoodies at 22.95; logos 150.00 + 180.00; set-up 45.00. Total 953.00.
const charges: Charge[] = [
  { description: "1C FF Sprout Logo", kind: "decoration", amount: 150 },
  { description: "2C FB Rexius Logo", kind: "decoration", amount: 180 },
  { description: "Screen Set Up for Reorder", kind: "setup", amount: 45 },
];
const r = spreadCharges([{ qty: 25, unit_cost: 9.35 }, { qty: 15, unit_cost: 22.95 }], charges);
assert.equal(r.summary.decoration_total, 330);
assert.equal(r.summary.setup_total, 45);
assert.equal(r.summary.units, 40);
assert.equal(r.summary.grouped, false);
assert.equal(r.lines[0].decoration_per_unit, 8.25);
assert.equal(r.lines[0].base_unit_cost, 9.35);
assert.equal(r.lines[0].unit_cost, 17.6);    // set-up is not in item cost
assert.equal(r.lines[1].unit_cost, 31.2);
assert.equal(round2(25 * 17.6 + 15 * 31.2 + 45), 953);

// A grouped invoice: logo charges stay with their own order's pieces.
const g = spreadCharges(
  [{ qty: 10, unit_cost: 10, group: "A" }, { qty: 20, unit_cost: 20, group: "B" }, { qty: 5, unit_cost: 5, group: "B" }],
  [{ description: "Logo A", kind: "decoration", amount: 30, group: "A" }, { description: "Logo B", kind: "decoration", amount: 50, group: "b" }, { description: "Fold", kind: "decoration", amount: 35 }],
);
assert.equal(g.summary.grouped, true);
assert.deepEqual(g.lines.map((l) => l.decoration_per_unit), [4, 3, 3]);   // A: 3 + 1; B: 2 + 1 (the ungrouped 35 goes on all 35 pieces)
assert.deepEqual(g.lines.map((l) => l.unit_cost), [14, 23, 8]);
// A charge naming a section that has no pieces falls back to every piece.
const f = spreadCharges([{ qty: 4, unit_cost: 1, group: "A" }], [{ description: "x", kind: "decoration", amount: 8, group: "Z" }]);
assert.equal(f.lines[0].unit_cost, 3);
assert.equal(f.summary.grouped, false);

// Nothing to spread, no pieces, missing prices, packing slips.
assert.equal(spreadCharges([{ qty: 5, unit_cost: 10 }], []).lines[0].unit_cost, 10);
assert.equal(spreadCharges([{ qty: 0, unit_cost: 10 }], [{ description: "x", kind: "decoration", amount: 20 }]).summary.unassigned, 20);
assert.equal(spreadCharges([{ qty: 2, unit_cost: null }], [{ description: "x", kind: "decoration", amount: 20 }]).lines[0].unit_cost, null);
assert.equal(spreadCharges([{ qty: 3, unit_cost: null }], [{ description: "Set-up", kind: "setup", amount: 20 }]).summary.setup_total, 20);
// Rounding to the cent: 9.35 + 375/40 = 18.725 -> 18.73
assert.equal(spreadCharges([{ qty: 40, unit_cost: 9.35 }], [{ description: "x", kind: "decoration", amount: 375 }]).lines[0].unit_cost, 18.73);

// Sizes
for (const [a, b] of [["LG", "L"], ["Large", "l"], ["4X", "4XL"], ["XXL", "2X"], ["x-large", "XL"], ["Youth M", "YM"], ["OSFA", "OS"]]) assert.equal(normSize(a), normSize(b), `${a} vs ${b}`);
assert.notEqual(normSize("M"), normSize("Youth M"));
assert.notEqual(normSize("3X"), normSize("4X"));
assert.equal(normSize(null), "");

// Designs
assert.equal(normDesign("18054 Rexius Sprout 2021"), "18054");
assert.equal(normDesign("Design 18054"), "18054");
assert.equal(normDesign("Fleet Services"), "fleet services");

// Part numbers with the size on the end
assert.equal(baseSku("2400_4X", "4X"), "2400");
assert.equal(baseSku("PC90H_4X", "4XL"), "pc90h");
assert.equal(baseSku("2400-LG", "L"), "2400");
assert.equal(baseSku("2400", "M"), "2400");
assert.equal(baseSku("PC90H", "S"), "pc90h");        // "PC90H" must not lose its "H"
assert.equal(baseSku("ABC-123", "M"), "abc-123");    // a suffix that isn't the size stays
assert.equal(baseSku("2400_4X", null), "2400_4x");

// The packing slip (2400_4X, size 4X) and the invoice (2400, size 4XL) agree.
const k = (sku: string, size: string) => aliasKey(sku, "Gildan LS tee", "Safety Green", size, "18054 Rexius Sprout 2021");
assert.equal(k("2400_4X", "4X"), k("2400", "4XL"));
assert.equal(k("2400", "4XL"), "2400 | safety green | 4xl | 18054");
// Different size, colour or design never share a match.
assert.notEqual(k("2400", "M"), k("2400", "L"));
assert.notEqual(aliasKey("2400", "x", "Safety Green", "M", "18054"), aliasKey("2400", "x", "Safety Orange", "M", "18054"));
assert.notEqual(aliasKey("2400", "x", "Safety Green", "M", "18054"), aliasKey("2400", "x", "Safety Green", "M", "Fleet Services"));
assert.equal(aliasKey(null, "Hi-Vis Vest", null, null, null), "hi-vis vest");
assert.equal(aliasKey(null, null, "Green", "M", null), "");
// Vendors
assert.equal(normVendor("Eugene Silkscreen, Inc."), "eugene silkscreen");
assert.equal(normVendor("EUGENE SILKSCREEN INC"), "eugene silkscreen");
assert.equal(normVendor("Eugene  Silkscreen"), "eugene silkscreen");
assert.equal(normVendor("Smith & Sons Co., LLC"), "smith and sons");
assert.equal(normVendor("Coburg Company Store Inc."), "coburg company store");
assert.equal(normVendor(""), "");
console.log("spread tests passed");
