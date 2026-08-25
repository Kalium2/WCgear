/**
 * patch-debuffs.js - real phase-keyed debuff values, and per-spec override hooks.
 *
 * Throwaway. Run once, check the output, delete it.
 *
 * TWO BUGS, both affecting EVERY spec (buildSpecRequest builds its base from
 * buildWarlockRequest and replaces only raid.parties, so this debuffs block is
 * what every simulation runs with):
 *
 * 1. exposeWeaknessUptime 1.0 / exposeWeaknessHunterAgility 1000 were GUESSES,
 *    with a code comment admitting as much. The real phase-keyed values from
 *    wowsims (ui/core/proto_utils/utils.ts) are 0.9 / 1210 at phase 3.
 *
 * 2. isbUptime was ABSENT ENTIRELY. Improved Shadow Bolt is a 20% shadow
 *    damage debuff at 72% uptime in phase 3, so every caster number this
 *    project has produced was computed without it.
 *
 * wowsims-parity.md records both as fixed on 2026-08-22. They are not in the
 * deployed file. Same pattern as patch-offhand.js, which was committed but
 * never run.
 *
 * EXPECT NUMBERS TO MOVE. Casters should rise noticeably (isbUptime), physical
 * specs a little (0.9 x 1210 = 1089 effective, against 1.0 x 1000 = 1000).
 * The parity baselines in wowsims-parity.md are invalidated by this patch and
 * must be re-measured - do not treat the old 5.9% / 8.4% figures as current.
 *
 * ALSO ADDS per-spec override hooks for debuffs and consumables. Needed for
 * Destruction (Fire), which differs by improvedScorch: true and conjuredId
 * 22788, and there is currently nowhere for a spec to say either.
 */

const fs = require("fs");
const path = require("path");

const FILE = "/root/wow-gear-check-server/sim.js";

const PHASE_TABLE = `// Phase-keyed raid debuff values, read from wowsims
// ui/core/proto_utils/utils.ts. NOT guesses - a guess lived here before and
// sat behind a comment admitting it, which is worse than no value at all
// because it looks authoritative.
//
// PINNED TO PHASE 3: runSimulation does not receive the phase. Threading it
// through is a known open thread. The phase4 difference is small
// (agility 1210 -> 1150, isbUptime unchanged), so this is a bounded
// inaccuracy for phase 4 users rather than an unbounded one.
const PHASE_DEBUFFS = {
  phase1: { exposeWeaknessUptime: 0.9, exposeWeaknessHunterAgility: 1080, isbUptime: 0.52 },
  phase2: { exposeWeaknessUptime: 0.9, exposeWeaknessHunterAgility: 1150, isbUptime: 0.59 },
  phase3: { exposeWeaknessUptime: 0.9, exposeWeaknessHunterAgility: 1210, isbUptime: 0.72 },
  phase4: { exposeWeaknessUptime: 0.9, exposeWeaknessHunterAgility: 1150, isbUptime: 0.72 },
  phase5: { exposeWeaknessUptime: 0.9, exposeWeaknessHunterAgility: 1250, isbUptime: 0.80 },
};
const ACTIVE_PHASE_DEBUFFS = PHASE_DEBUFFS.phase3;

function buildWarlockRequest(`;

const EDITS = [
  // 1. Define the table immediately before the request builder.
  ["function buildWarlockRequest(", PHASE_TABLE],

  // 2. Open the debuffs literal so a spec can override it.
  [
    `      debuffs: {
        curseOfElements: "TristateEffectImproved",`,
    `      // Object.assign so a build can override individual debuffs -
      // Destruction (Fire) needs improvedScorch: true, and there was
      // previously nowhere to put it.
      debuffs: Object.assign({
        curseOfElements: "TristateEffectImproved",`,
  ],

  // 3. Real values, isbUptime added, and close the merge.
  [
    `        // Expose Weakness is modelled as uptime x the hunter's agility, not a flag.
        // ASSUMPTION: a dedicated T6 BM hunter. Verify against wowsims before
        // treating physical numbers as validated.
        exposeWeaknessUptime: 1.0,
        exposeWeaknessHunterAgility: 1000,
      },`,
    `        // Expose Weakness is modelled as uptime x the hunter's agility, not a
        // flag. These are wowsims' real phase-keyed values, not an assumption.
        exposeWeaknessUptime: ACTIVE_PHASE_DEBUFFS.exposeWeaknessUptime,
        exposeWeaknessHunterAgility: ACTIVE_PHASE_DEBUFFS.exposeWeaknessHunterAgility,
        // Improved Shadow Bolt: +20% shadow damage taken, at this phase's
        // uptime. Was absent entirely, so every caster figure this project has
        // produced until now was computed without it.
        isbUptime: ACTIVE_PHASE_DEBUFFS.isbUptime,
      }, spec.debuffs || {}),`,
  ],

  // 4. Per-spec consumables override (Destro Fire uses conjuredId 22788).
  [
    `    consumables: {
      flaskId: 22866,     // Flask of Pure Death`,
    `    // Object.assign so a build can override single consumables - Destruction
    // (Fire) swaps the Demonic Rune for conjuredId 22788.
    consumables: Object.assign({
      flaskId: 22866,     // Flask of Pure Death`,
  ],
  [
    `      petScrollAgi: true,
      petScrollStr: true,
    },`,
    `      petScrollAgi: true,
      petScrollStr: true,
    }, spec.consumables || {}),`,
  ],
];

let src = fs.readFileSync(FILE, "utf8");

if (src.includes("isbUptime")) {
  console.log("sim.js: already patched (isbUptime present). Nothing to do.");
  process.exit(0);
}

const missing = EDITS.filter(([a]) => !src.includes(a));
if (missing.length) {
  console.error(`\nABORT: ${missing.length} anchor(s) did not match sim.js.\n`);
  missing.forEach(([a]) => console.error("--- expected ---\n" + a + "\n"));
  process.exit(1);
}

for (const [a, r] of EDITS) src = src.replace(a, r);

const bak = FILE + ".bak-debuffs";
if (fs.existsSync(bak)) console.log("Backup already exists, leaving it alone.");
else { fs.copyFileSync(FILE, bak); console.log("Backed up to " + path.basename(bak)); }

fs.writeFileSync(FILE, src);
console.log("Patched sim.js - all 5 edits applied.");
console.log("");
console.log("EXPECT DPS TO CHANGE. Casters up (Improved Shadow Bolt now applied),");
console.log("physical up slightly (Expose Weakness 0.9 x 1210 vs 1.0 x 1000).");
console.log("The parity baselines in wowsims-parity.md are now stale.");
