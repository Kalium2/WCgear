/**
 * patch-genbis.js - adds hunter hit/weapon gear-set variants to GENERATE.
 *
 * Throwaway. Run once, check the output, delete it.
 *
 * WHY THIS NEEDS NO OTHER CHANGES: genbis.js writes to bis[phase][spec] and
 * never interprets the spec key. So a variant is just a spec key with a
 * suffix - "beast_mastery_hunter@2h_9p" - and every existing guard still
 * applies unchanged:
 *   - the curated-block check compares _source, which new keys don't have
 *   - the populated-slot guard still rejects empty presets
 *   - generated entries still carry their own gems/enchant, so the hit
 *     gemming travels WITH the recommendation and the server never has to
 *     look up a preset for it
 *
 * The existing "beast_mastery_hunter" block is hand-curated and is left
 * completely alone - it stays the default recommendation.
 *
 * Verified 2026-08-25: all 16 combinations return HTTP 200 upstream. There
 * are no 3% variants at this tier; those exist only in phase 1.
 */

const fs = require("fs");
const path = require("path");

const FILE = "/root/wow-gear-check-server/genbis.js";

const ANCHOR = '  { spec: "shadow_priest",      phase: "phase3", preset: "presets/priest_dps/p3.gear.json" },';

const SPECS = [
  ["bm", "beast_mastery_hunter"],
  ["sv", "survival_hunter"],
];
const WEAPONS = ["2h", "dw"];
const HITS = ["6p", "9p"];

const HEADER = [
  "",
  "  // --- Hunter gear-set variants (added 2026-08-25) -------------------------",
  "  // Two axes, both real: weapon config (two-hand vs dual-wield) and the hit",
  "  // assumption (6% for a raid running Improved Faerie Fire + Misery, 9%",
  "  // without). Upstream ships all 16 for P3/P4; the 3% variants are P1 only.",
  "  //",
  "  // The '@variant' suffix is opaque to this generator - it is only a key. The",
  "  // hand-curated beast_mastery_hunter block is untouched and stays default.",
];

const jobs = [];

// Survival has a working sim but NO bis.json block, so Upgrade Priority has
// nothing to sweep for it. Generate a default from the 2h_6p set - the same
// hit assumption the existing BM gemming reference uses, and the right one for
// a raid running Improved Faerie Fire + Misery. Beast Mastery is deliberately
// absent here: its block is hand-curated and must stay that way.
jobs.push(
  '  { spec: "survival_hunter", phase: "phase3", preset: "presets/hunter_dps/phase_3/sv/2h_6p.gear.json" },',
  '  { spec: "survival_hunter", phase: "phase4", preset: "presets/hunter_dps/phase_4/sv/2h_6p.gear.json" },'
);

for (const phase of ["phase3", "phase4"]) {
  const n = phase === "phase3" ? 3 : 4;
  for (const [dir, spec] of SPECS) {
    for (const w of WEAPONS) {
      for (const h of HITS) {
        const key = `${spec}@${w}_${h}`;
        jobs.push(
          `  { spec: "${key}", phase: "${phase}", ` +
          `preset: "presets/hunter_dps/phase_${n}/${dir}/${w}_${h}.gear.json" },`
        );
      }
    }
  }
}

let src = fs.readFileSync(FILE, "utf8");

if (src.includes("@2h_6p")) {
  console.log("genbis.js: variants already present. Nothing to do.");
  process.exit(0);
}
if (!src.includes(ANCHOR)) {
  console.error("ABORT: anchor not found in genbis.js. Expected this line:\n" + ANCHOR);
  process.exit(1);
}

src = src.replace(ANCHOR, ANCHOR + "\n" + HEADER.concat(jobs).join("\n"));

const bak = FILE + ".bak-variants";
if (fs.existsSync(bak)) console.log("Backup already exists, leaving it alone.");
else { fs.copyFileSync(FILE, bak); console.log("Backed up to " + path.basename(bak)); }

fs.writeFileSync(FILE, src);
console.log(`Patched genbis.js - added ${jobs.length} variant jobs.`);
console.log("Download the gear sets before running it.");
