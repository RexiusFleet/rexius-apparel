import assert from "node:assert/strict";
import { aliasKey, spreadAddOns, round2 } from "./spread.ts";

// Invoice 66123: 25 tees at 9.35, 15 hoodies at 22.95, logos 150.00 + 180.00, set-up 45.00. Total 953.00.
const r = spreadAddOns(
  [{ qty: 25, unit_cost: 9.35 }, { qty: 15, unit_cost: 22.95 }],
  [{ description: "1C FF Sprout Logo", kind: "decoration", amount: 150 }, { description: "2C FB Rexius Logo", kind: "decoration", amount: 180 }, { description: "Screen Set Up for Reorder", kind: "setup", amount: 45 }],
);
assert.equal(r.spread?.total, 375);
assert.equal(r.spread?.units, 40);
assert.equal(r.spread?.per_unit, 9.375);
assert.equal(r.lines[0].base_unit_cost, 9.35);
assert.equal(r.lines[0].unit_cost, 18.73);   // 9.35 + 9.375 = 18.725
assert.equal(r.lines[1].unit_cost, 32.33);   // 22.95 + 9.375 = 32.325
const exact = 25 * (9.35 + 9.375) + 15 * (22.95 + 9.375);
assert.equal(round2(exact), 953);
const drift = round2(25 * 18.73 + 15 * 32.33 - 953);
assert.equal(drift, 0.2);                     // cents lost to rounding per-unit costs to the cent

// Nothing to spread, no pieces, and missing costs.
assert.equal(spreadAddOns([{ qty: 5, unit_cost: 10 }], []).spread, null);
assert.equal(spreadAddOns([{ qty: 0, unit_cost: 10 }], [{ description: "x", kind: "setup", amount: 20 }]).spread, null);
assert.equal(spreadAddOns([{ qty: 2, unit_cost: null }], [{ description: "x", kind: "setup", amount: 20 }]).lines[0].unit_cost, null);

// Same part number, different size or colour, must not share a remembered match.
assert.notEqual(aliasKey("2400", "Gildan LS Tee", "Safety Green", "M"), aliasKey("2400", "Gildan LS Tee", "Safety Green", "L"));
assert.notEqual(aliasKey("2400", "Gildan LS Tee", "Safety Green", "M"), aliasKey("2400", "Gildan LS Tee", "Safety Orange", "M"));
assert.equal(aliasKey(" 2400 ", "x", "Safety  Green", "m"), aliasKey("2400", "y", "safety green", "M"));
assert.equal(aliasKey(null, "Hi-Vis Vest", null, null), "hi-vis vest");
assert.equal(aliasKey(null, null, "Green", "M"), "");
console.log("spread tests passed");
