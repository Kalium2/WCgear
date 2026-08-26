/**
 * verify-mh.js - what is a main-hand swap actually worth, and is the off-hand
 * really being cleared?
 *
 *   node verify-mh.js <reportCode> <characterName> <specKey> <targetItemId> [phase]
 *   e.g. node verify-mh.js Ytdm1AGnrNgxzqXh Drexion beast_mastery_hunter 34196 phase3
 *
 * Read-only. Pulls the character's REAL gear from the live /api/character, then
 * runs three paired sims that differ in exactly one thing each:
 *
 *   A. current gear, untouched                      <- the sweep's baseline
 *   B. target in slot 14, OFF-HAND CLEARED          <- what the sweep should do
 *   C. target in slot 14, off-hand LEFT EQUIPPED    <- the old, wrong behaviour
 *
 * B is the honest answer. C - B is the inflation the off-hand bug produced.
 * If B and C are identical, the off-hand was already empty and this character
 * cannot demonstrate the bug either way.
 *
 * Gemming and enchant are borrowed from the same wowsims preset the sweep uses,
 * so B reproduces the sweep's arithmetic rather than approximating it.
 */

const fs = require("fs");
const path = require("path");
const DIR = "/root/wow-gear-check-server/";

const { runSimulation, buildEquipmentSpec } = require(DIR + "sim.js");
const { loadGameDatabase, getItem } = require(DIR + "gamedb.js");

const [reportCode, charName, specKey, targetIdRaw, phaseRaw] = process.argv.slice(2);
if (!reportCode || !charName || !specKey || !targetIdRaw) {
  console.error("Usage: node verify-mh.js <reportCode> <characterName> <specKey> <targetItemId> [phase]");
  process.exit(1);
}
const targetId = Number(targetIdRaw);
const phaseKey = phaseRaw === "phase4" ? "phase4" : "phase3";

const PRESETS = {
  Warlock: { phase3: "presets/warlock/t6.gear.json", phase4: "presets/warlock/za.gear.json" },
  Shaman: { phase3: "presets/shaman_elemental/p3.gear.json", phase4: "presets/shaman_elemental/p4.gear.json" },
  Warrior: { phase3: "presets/warrior_dps/p3_arms.gear.json", phase4: "presets/warrior_dps/p4_arms.gear.json" },
  Hunter: { phase3: "presets/hunter_dps/p3_bm.gear.json", phase4: "presets/hunter_dps/p4_bm.gear.json" },
};

const dps = (r) => (r && r.raidMetrics && r.raidMetrics.dps ? r.raidMetrics.dps.avg : null);
const nameOf = (id) => { const i = id ? getItem(id) : null; return i ? i.name : (id ? "item " + id : "(empty)"); };

(async () => {
  await loadGameDatabase();

  const url = "http://localhost/api/character?name=" + encodeURIComponent(charName) +
              "&reportCode=" + encodeURIComponent(reportCode);
  const res = await fetch(url);
  const data = await res.json();
  if (!data || !data.gear) throw new Error("could not load character: " + (data && data.error));

  const current = buildEquipmentSpec(data.gear, data.equippedItemDetails || {});
  const mh = (current.items[14] || {}).id || null;
  const oh = (current.items[15] || {}).id || null;

  const target = getItem(targetId);
  const isTwoHander = Boolean(target && target.type === 13 && target.handType === 4);

  console.log("Character : " + data.name + " (" + data.class + ")   spec " + specKey);
  console.log("Main hand : " + nameOf(mh));
  console.log("Off hand  : " + nameOf(oh));
  console.log("Target    : " + nameOf(targetId) +
    (target ? "  type=" + target.type + " handType=" + target.handType : "") +
    (isTwoHander ? "  <- two-hander" : "  <- NOT a two-hander"));
  if (!oh) console.log("\nNOTE: off-hand already empty - B and C will be identical by construction.");
  console.log("");

  // Same gemming source the sweep uses.
  const rel = (PRESETS[data.class] || {})[phaseKey];
  let presetSlot14 = {};
  try { presetSlot14 = (JSON.parse(fs.readFileSync(path.join(DIR, rel), "utf8")).items || [])[14] || {}; }
  catch (e) { console.log("(no preset gemming available: " + e.message.split("\n")[0] + ")"); }

  const sockets = target && Array.isArray(target.gemSockets) ? target.gemSockets.length : 0;
  const targetSpec = {
    id: targetId,
    enchant: presetSlot14.enchant || 0,
    gems: (Array.isArray(presetSlot14.gems) ? presetSlot14.gems.filter(Boolean) : []).slice(0, sockets),
  };
  console.log("Target gemming (borrowed from preset): enchant " + targetSpec.enchant +
              ", gems [" + targetSpec.gems.join(", ") + "]\n");

  const withCleared = { items: current.items.map((it, i) => (i === 14 ? targetSpec : i === 15 ? {} : it)) };
  const withKept    = { items: current.items.map((it, i) => (i === 14 ? targetSpec : it)) };
  // D isolates a separate question: do melee weapons contribute DAMAGE here, or
  // only stats? A raiding hunter never melees, so stripping both weapons should
  // cost only their stats. If D craters, the sim is melee-weaving and weapon
  // damage dominates - which would explain a large weapon delta with no
  // off-hand bug involved at all.
  const noWeapons   = { items: current.items.map((it, i) => (i === 14 || i === 15 ? {} : it)) };

  console.log("Running A (current gear)...");
  const a = dps(await runSimulation(data.gear, data.equippedItemDetails, current, specKey));
  console.log("Running B (target equipped, off-hand cleared)...");
  const b = dps(await runSimulation(data.gear, data.equippedItemDetails, withCleared, specKey));
  console.log("Running C (target equipped, off-hand kept - the old bug)...");
  const c = dps(await runSimulation(data.gear, data.equippedItemDetails, withKept, specKey));
  console.log("Running D (no melee weapons at all)...");
  const d = dps(await runSimulation(data.gear, data.equippedItemDetails, noWeapons, specKey));

  if (a == null || b == null || c == null) return console.log("\nOne or more sims returned no DPS.");

  console.log("\n  A  current gear                    : " + a.toFixed(1));
  console.log("  B  target, off-hand cleared        : " + b.toFixed(1) + "   delta " + (b - a >= 0 ? "+" : "") + (b - a).toFixed(1));
  console.log("  C  target, off-hand kept (wrong)   : " + c.toFixed(1) + "   delta " + (c - a >= 0 ? "+" : "") + (c - a).toFixed(1));
  console.log("  D  no melee weapons                : " + (d == null ? "FAILED" : d.toFixed(1)) +
    (d == null ? "" : "   delta " + (d - a >= 0 ? "+" : "") + (d - a).toFixed(1)));
  console.log("  Inflation the bug produced (C - B) : " + (c - b >= 0 ? "+" : "") + (c - b).toFixed(1) + "\n");

  if (d != null) {
    const lostPct = ((a - d) / a) * 100;
    console.log("Stripping both melee weapons costs " + lostPct.toFixed(1) + "% of total DPS.");
    if (lostPct > 12) {
      console.log("That is FAR more than their stats are worth - this spec is being");
      console.log("simulated as melee-weaving, so weapon damage dominates. A large weapon");
      console.log("delta then has nothing to do with the off-hand, and is a question about");
      console.log("whether the rotation should be weaving at all.");
    } else {
      console.log("That is consistent with stats only, so melee damage is not a factor");
      console.log("and the weapon delta is a straight stat trade.");
    }
  }

  console.log("The Upgrade Priority panel should be showing B's delta, " +
              (b - a >= 0 ? "+" : "") + (b - a).toFixed(1) + ".");
  console.log("If the panel shows C's delta instead, the fix is not in the running code.");
  console.log("If the panel matches B and you still disagree with the number, the");
  console.log("disagreement is about gear/gemming or the comparison baseline - not the off-hand.");
})().catch((e) => console.error("FAILED: " + e.message));
