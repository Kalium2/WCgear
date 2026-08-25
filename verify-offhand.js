/**
 * verify-offhand.js - does clearing the off-hand actually change anything?
 *
 * Read-only. Runs two paired simulations on wowsims' own T6 Warlock preset
 * (a two-handed staff build, so slot 15 is empty in the preset):
 *
 *   A. staff, off-hand EMPTY      <- what the sim should do
 *   B. staff, off-hand POPULATED  <- the impossible set-up the bug produced
 *
 * If B > A, the off-hand is contributing stats it should not, which is exactly
 * the inflation the patch removes. If B == A, then either the off-hand item
 * chosen is worthless or the engine already ignores it - and the patch, while
 * still correct, was not the cause of the 50 DPS gap.
 *
 * randomSeed is pinned to 1 in sim.js, so the two runs are paired and any
 * difference is the gear, not Monte Carlo noise.
 */

const fs = require("fs");
const path = require("path");
const DIR = "/root/wow-gear-check-server/";

const { runSimulation } = require(DIR + "sim.js");
const { loadGameDatabase, getItem, allItems } = require(DIR + "gamedb.js");

const SPEC = "destruction_warlock";
const PRESET = "presets/warlock/t6.gear.json";

(async () => {
  await loadGameDatabase();

  const preset = JSON.parse(fs.readFileSync(path.join(DIR, PRESET), "utf8"));
  const items = preset.items.map((it) => (it && it.id ? it : {}));

  const mh = items[14] || {};
  const mhItem = mh.id ? getItem(mh.id) : null;
  console.log("Main hand : " + (mhItem ? mhItem.name : "(empty)") +
    "  type=" + (mhItem && mhItem.type) + " handType=" + (mhItem && mhItem.handType) +
    (mhItem && mhItem.handType === 4 ? "  <- two-hander, good" : "  <- NOT a two-hander, test is meaningless"));
  console.log("Off hand  : " + (items[15] && items[15].id ? getItem(items[15].id).name : "(empty)"));

  // Find a caster off-hand to stuff into slot 15: an OffHand-type weapon
  // carrying spell damage, i.e. something a warlock would really wear.
  let pick = null;
  for (const it of allItems().values()) {
    if (!it || it.type !== 13) continue;
    if (it.handType !== 3 && it.weaponType !== 5) continue;
    if (it.armorType && it.armorType > 1) continue;
    const sc = it.scalingOptions && it.scalingOptions["0"];
    const stats = (sc && sc.stats) || {};
    const spellPower = Number(stats["13"] || 0) + Number(stats["14"] || 0);
    if (spellPower <= 0) continue;
    if (!pick || spellPower > pick.power) pick = { item: it, power: spellPower };
  }

  if (!pick) { console.log("\nNo caster off-hand found in db.bin - cannot run the test."); return; }
  console.log("Test off-hand: " + pick.item.name + " (id " + pick.item.id + ", ~" + pick.power + " spell power)\n");

  const withEmpty = { items: items.map((it, i) => (i === 15 ? {} : it)) };
  const withOff = { items: items.map((it, i) => (i === 15 ? { id: pick.item.id, enchant: 0, gems: [] } : it)) };

  const dps = (r) => (r && r.raidMetrics && r.raidMetrics.dps ? r.raidMetrics.dps.avg : null);

  console.log("Running A (off-hand empty)...");
  const a = dps(await runSimulation({}, {}, withEmpty, SPEC));
  console.log("Running B (off-hand populated - the impossible set-up)...");
  const b = dps(await runSimulation({}, {}, withOff, SPEC));

  console.log("\n  A  two-hander, off-hand empty      : " + (a == null ? "FAILED" : a.toFixed(1)));
  console.log("  B  two-hander + off-hand (illegal) : " + (b == null ? "FAILED" : b.toFixed(1)));

  if (a == null || b == null) return;
  const gap = b - a;
  console.log("  Difference                         : " + (gap >= 0 ? "+" : "") + gap.toFixed(1) + " DPS\n");

  if (Math.abs(gap) < 1) {
    console.log("VERDICT: no meaningful difference. The engine appears to ignore an");
    console.log("off-hand under a two-hander, so the patch is correct but was NOT the");
    console.log("cause of the sweep/loot-check gap. Look elsewhere for the ~50 DPS.");
  } else if (gap > 0) {
    console.log("VERDICT: confirmed. The illegal set-up reads " + gap.toFixed(1) + " DPS higher,");
    console.log("so leaving the off-hand equipped inflated every two-hander. The patch");
    console.log("removes exactly this.");
  } else {
    console.log("VERDICT: unexpected - the off-hand LOWERED dps. Worth investigating");
    console.log("before trusting either figure.");
  }
})().catch((e) => console.error("FAILED: " + e.message));
