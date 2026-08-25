/**
 * verify-isb.js - is Improved Shadow Bolt actually doing anything?
 *
 * Read-only. Two paired sims on wowsims' own T6 Warlock preset, identical in
 * every respect except isbUptime:
 *
 *   A. isbUptime = 0     <- what every simulation before today ran with
 *   B. isbUptime = 0.72  <- phase 3's real value
 *
 * ISB is a 20% shadow-damage-taken debuff. At 72% uptime, on a spec whose
 * damage is largely Shadow Bolt, B should be several percent above A. If the
 * gap is near zero, the field is reaching the engine but the engine is not
 * acting on it - which is a different problem from the field being dropped,
 * and worth knowing before trusting any caster number.
 *
 * This works by passing debuff overrides through runSimulation's playerOverrides
 * argument: applySpecOverrides clones the spec with them attached, and
 * buildWarlockRequest merges spec.debuffs over the defaults.
 *
 * randomSeed is pinned to 1, so the two runs are paired.
 *
 * NOTE: warlock specs only. buildSpecRequest builds its base from the
 * DESTRUCTION WARLOCK spec, so spec.debuffs overrides never reach a Shaman,
 * Warrior or Hunter. That is a real limitation of the override hook, recorded
 * rather than worked around here.
 */

const fs = require("fs");
const path = require("path");
const DIR = "/root/wow-gear-check-server/";

const { runSimulation } = require(DIR + "sim.js");
const { loadGameDatabase } = require(DIR + "gamedb.js");

const SPEC = "destruction_warlock";
const PRESET = "presets/warlock/t6.gear.json";

const dps = (r) => (r && r.raidMetrics && r.raidMetrics.dps ? r.raidMetrics.dps.avg : null);

(async () => {
  await loadGameDatabase();

  const preset = JSON.parse(fs.readFileSync(path.join(DIR, PRESET), "utf8"));
  const equipment = { items: preset.items.map((it) => (it && it.id ? it : {})) };

  console.log("Spec: " + SPEC + "   Gear: " + PRESET + "\n");

  console.log("Running A (isbUptime = 0, i.e. how every sim ran until today)...");
  const a = dps(await runSimulation({}, {}, equipment, SPEC, { debuffs: { isbUptime: 0 } }));

  console.log("Running B (isbUptime = 0.72, phase 3's real value)...");
  const b = dps(await runSimulation({}, {}, equipment, SPEC, { debuffs: { isbUptime: 0.72 } }));

  console.log("\n  A  isbUptime 0.00 : " + (a == null ? "FAILED" : a.toFixed(1)));
  console.log("  B  isbUptime 0.72 : " + (b == null ? "FAILED" : b.toFixed(1)));
  if (a == null || b == null) return;

  const gap = b - a;
  const pct = (gap / a) * 100;
  console.log("  Difference        : " + (gap >= 0 ? "+" : "") + gap.toFixed(1) +
              " DPS (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%)\n");

  if (Math.abs(pct) < 0.5) {
    console.log("VERDICT: the engine is IGNORING isbUptime. The field name is correct");
    console.log("and it is being encoded, so this is a modelling gap in wowsimtbc, not");
    console.log("a transport bug. Do not credit Improved Shadow Bolt in any explanation");
    console.log("of caster numbers, and expect a permanent gap against wowsims.com.");
  } else if (pct > 4) {
    console.log("VERDICT: isbUptime works as expected. Then the 1.7% jump from");
    console.log("2595.3 to 2640.5 has a different cause - most likely the 2595.3");
    console.log("baseline was measured under conditions we have since changed.");
  } else {
    console.log("VERDICT: isbUptime has SOME effect but less than expected for a");
    console.log("Shadow Bolt spec. Worth checking what fraction of this build's damage");
    console.log("is actually shadow before drawing conclusions.");
  }
})().catch((e) => console.error("FAILED: " + e.message));
