/**
 * baselines.js - one paired-seed baseline per spec, on wowsims' own preset gear.
 *
 * Read-only. Sequential (one core, and wowsimtbc has no cancellation, so
 * overlapping sims only halve throughput).
 *
 * Run after any change to buffs, debuffs, the encounter or player settings.
 * randomSeed is pinned to 1, so these are directly comparable to each other and
 * to any earlier run - which is what makes a single-variable change measurable.
 *
 * Casters ~3-4s each, physical specs ~8-10s. Budget about a minute and a half.
 */

const fs = require("fs");
const path = require("path");
const DIR = "/root/wow-gear-check-server/";

const { runSimulation } = require(DIR + "sim.js");
const { loadGameDatabase } = require(DIR + "gamedb.js");

// [specKey, preset gear file, last recorded wowsims figure or null]
const SPECS = [
  ["destruction_warlock",   "presets/warlock/t6.gear.json",                    2759.10],
  ["affliction_warlock",    "presets/warlock/t6.gear.json",                    null],
  ["demonology_warlock",    "presets/warlock/t6.gear.json",                    null],
  ["elemental_shaman",      "presets/shaman_elemental/p3.gear.json",           null],
  ["arms_warrior",          "presets/warrior_dps/p3_arms.gear.json",           null],
  ["fury_warrior",          "presets/warrior_dps/p3_fury.gear.json",           null],
  ["beast_mastery_hunter",  "presets/hunter_dps/p3_bm.gear.json",              3739.91],
  ["survival_hunter",       "presets/hunter_dps/phase_3/sv/2h_6p.gear.json",   null],
];

const dps = (r) => (r && r.raidMetrics && r.raidMetrics.dps ? r.raidMetrics.dps.avg : null);

(async () => {
  await loadGameDatabase();
  const rows = [];

  for (const [spec, presetFile, theirs] of SPECS) {
    const full = path.join(DIR, presetFile);
    if (!fs.existsSync(full)) {
      rows.push([spec, null, theirs, "preset missing: " + presetFile]);
      console.log("SKIP " + spec + " - no " + presetFile);
      continue;
    }
    const preset = JSON.parse(fs.readFileSync(full, "utf8"));
    const equipment = { items: preset.items.map((it) => (it && it.id ? it : {})) };

    process.stdout.write("Running " + spec + " ... ");
    try {
      const v = dps(await runSimulation({}, {}, equipment, spec));
      console.log(v == null ? "no result" : v.toFixed(1));
      rows.push([spec, v, theirs, null]);
    } catch (e) {
      console.log("FAILED - " + e.message.split("\n")[0]);
      rows.push([spec, null, theirs, e.message.split("\n")[0]]);
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log("spec".padEnd(24) + "ours".padStart(10) + "wowsims".padStart(12) + "gap".padStart(12));
  console.log("=".repeat(72));
  for (const [spec, ours, theirs, err] of rows) {
    if (err) { console.log(spec.padEnd(24) + "  " + err); continue; }
    const gap = theirs && ours ? (((ours - theirs) / theirs) * 100).toFixed(1) + "%" : "-";
    console.log(
      spec.padEnd(24) +
      (ours == null ? "-" : ours.toFixed(1)).padStart(10) +
      (theirs == null ? "-" : theirs.toFixed(2)).padStart(12) +
      gap.padStart(12)
    );
  }
  console.log("=".repeat(72));
  console.log("\nNegative gap = we read low. wowsims figures are from earlier");
  console.log("cross-checks and their site is on Phase 2, so treat them as indicative.");
})().catch((e) => console.error("FAILED: " + e.message));
