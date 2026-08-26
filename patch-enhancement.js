/**
 * patch-enhancement.js - Enhancement Shaman, all three upstream talent builds.
 *
 * Throwaway. Run once, check the output, delete it.
 *
 * Every value transcribed from wowsims/tbc-new ui/shaman/enhancement/presets.ts,
 * read directly on the VPS 2026-08-25 (not through a summariser).
 *
 * Upstream defines three talent builds and marks none of them default, so all
 * three ship as spec keys - `bis.json` already covers enhancement_shaman and
 * genbis gains jobs for the other two from the same gear set.
 *
 * FIVE THINGS THIS GETS RIGHT THAT A COPY-PASTE WOULD NOT:
 *
 * 1. `imbueOh` and `syncType` live on the OPTIONS message, not classOptions.
 *    buildSpecPlayer only ever wrote { options: { classOptions } }, so there
 *    was nowhere to put them - an Enhancement shaman would have simmed with no
 *    off-hand Windfury imbue. Adds a generic `specOptions` merge.
 *
 * 2. Party buffs carry NO TOTEMS. Enhancement drops its own through the APL;
 *    listing Windfury Totem as an incoming party buff would double-count it.
 *    Upstream's block is exactly four entries and this matches it.
 *
 * 3. Melee consumables, not caster ones - Haste Potion, Flask of Relentless
 *    Assault, Roasted Clefthoof, sappers and scrolls.
 *
 * 4. distanceFromTarget 5, not Elemental's 20. It is a melee spec.
 *
 * 5. Its own gemming reference. Without a PRESET_BY_SPEC_PHASE entry it falls
 *    back to the class map and borrows ELEMENTAL caster gear - the same trap
 *    Fury had with Arms.
 *
 * The APL references Earth Shock and Magma Totem; its valueVariables are named
 * condition helpers, not behaviour switches, so nothing is inherited blind
 * (checked after the hunter melee-weave discovery).
 */

const fs = require("fs");
const path = require("path");

const DIR = "/root/wow-gear-check-server/";

// Shared across all three builds - only talents, key and label differ.
const shared = `    specField: "enhancementShaman",
    class: "ClassShaman",
    race: "RaceOrc",
    aplPath: "shaman_enhancement/apls/default.apl.json",
    profession1: "Engineering",
    profession2: "Leatherworking",
    distanceFromTarget: 5,
    classOptions: {
      shieldProcrate: 0,
      imbueMh: "WindfuryWeapon",
    },
    // These sit on the OPTIONS message, one level above classOptions. Without
    // the specOptions merge in sim.js they have nowhere to go and the off-hand
    // imbue is silently lost.
    specOptions: {
      imbueOh: "WindfuryWeapon",
      syncType: "DelayOffhandSwings",
    },
    consumables: {
      potId: 22838,      // Haste Potion
      flaskId: 22854,    // Flask of Relentless Assault
      foodId: 27658,     // Roasted Clefthoof
      conjuredId: 22788,
      explosiveId: 30217,
      drumsId: "LesserDrumsOfBattle",
      superSapper: true, goblinSapper: true, scrollAgi: true, scrollStr: true,
    },
    buffs: { blessingOfKings: true, blessingOfMight: "TristateEffectImproved" },
    // NO TOTEMS. Enhancement casts its own through the rotation; an incoming
    // Windfury Totem party buff would double-count it. Upstream's block is
    // exactly these four entries.
    partyBuffs: {
      ferociousInspiration: 2,
      braidedEterniumChain: true,
      leaderOfThePack: "TristateEffectRegular",
      battleShout: "TristateEffectImproved",
    },`;

const BUILDS = [
  ["enhancement", "Enhancement (IWT)", "03-500502210501133531151-50005301", "Sub-Restoration, Improved Windfury Totem"],
  ["enhancement_ils", "Enhancement (ILS)", "03-500503210500133531151-50005301", "Sub-Restoration, Improved Lightning Shield"],
  ["enhancement_ele", "Enhancement (Sub-Ele)", "250031501-500503210500133531151", "Sub-Elemental"],
];

const entries = BUILDS.map(([key, label, talents, note]) =>
  `  // ${note}\n` +
  `  ${key}: {\n` +
  `    key: "${key}_shaman",\n` +
  `    label: "${label}",\n` +
  `    talents: "${talents}",\n` +
  shared + "\n  },"
).join("\n");

const WORK = [
  // Marker must be text that exists ONLY after patching. "enhancement" alone
  // matches any path containing shaman_enhancement and silently skips the file.
  ["shamanspecs.js", "Enhancement (IWT)", [
    ["const SHAMAN_SPECS = {",
     "const SHAMAN_SPECS = {\n" +
     "  // --- Enhancement, added 2026-08-25 ------------------------------------\n" +
     "  // Upstream ships three talent builds and marks none of them default, so\n" +
     "  // all three are offered rather than one being picked for the user.\n" +
     entries],
  ]],

  ["sim.js", "specOptions", [
    ["  player[spec.specField] = { options: { classOptions: spec.classOptions } };",
     "  // specOptions merges at the OPTIONS level, above classOptions. Enhancement\n" +
     "  // needs it for imbueOh and syncType; without it the off-hand weapon imbue\n" +
     "  // is dropped silently and a Windfury spec sims far too low.\n" +
     "  player[spec.specField] = {\n" +
     "    options: Object.assign({ classOptions: spec.classOptions }, spec.specOptions || {}),\n" +
     "  };"],
  ]],

  ["server.js", "enhancement_shaman:", [
    ["const PRESET_BY_SPEC_PHASE = {",
     "const PRESET_BY_SPEC_PHASE = {\n" +
     "  // Enhancement is melee - without these it falls back to the class map and\n" +
     "  // borrows ELEMENTAL caster gemming.\n" +
     '  enhancement_shaman:     { phase3: "presets/shaman_enhancement/p3.gear.json", phase4: "presets/shaman_enhancement/p4.gear.json" },\n' +
     '  enhancement_ils_shaman: { phase3: "presets/shaman_enhancement/p3.gear.json", phase4: "presets/shaman_enhancement/p4.gear.json" },\n' +
     '  enhancement_ele_shaman: { phase3: "presets/shaman_enhancement/p3.gear.json", phase4: "presets/shaman_enhancement/p4.gear.json" },'],
  ]],

  ["genbis.js", "enhancement_ils_shaman", [
    ['  { spec: "enhancement_shaman", phase: "phase4", preset: "presets/shaman_enhancement/p4.gear.json" },',
     '  { spec: "enhancement_shaman", phase: "phase4", preset: "presets/shaman_enhancement/p4.gear.json" },\n' +
     "  // The other two Enhancement builds share one gear set upstream - only the\n" +
     "  // talents differ, so the recommendations are identical.\n" +
     '  { spec: "enhancement_ils_shaman", phase: "phase3", preset: "presets/shaman_enhancement/p3.gear.json" },\n' +
     '  { spec: "enhancement_ils_shaman", phase: "phase4", preset: "presets/shaman_enhancement/p4.gear.json" },\n' +
     '  { spec: "enhancement_ele_shaman", phase: "phase3", preset: "presets/shaman_enhancement/p3.gear.json" },\n' +
     '  { spec: "enhancement_ele_shaman", phase: "phase4", preset: "presets/shaman_enhancement/p4.gear.json" },'],
  ]],
];

const staged = [];
for (const [file, marker, edits] of WORK) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) throw new Error(`ABORT: ${file} not found.`);
  let src = fs.readFileSync(p, "utf8");
  if (src.includes(marker)) { console.log(`${file}: already patched, skipping.`); continue; }

  const missing = edits.filter(([a]) => !src.includes(a));
  if (missing.length) {
    console.error(`\nABORT: anchor not found in ${file}:\n`);
    missing.forEach(([a]) => console.error(a.split("\n")[0] + "\n"));
    process.exit(1);
  }
  for (const [a, r] of edits) src = src.replace(a, r);
  staged.push([file, src]);
}

if (!staged.length) { console.log("\nNothing to do."); process.exit(0); }

for (const [file, src] of staged) {
  const target = path.join(DIR, file);
  const bak = target + ".bak-enh";
  if (fs.existsSync(bak)) console.log(`${file}: backup exists, leaving it.`);
  else { fs.copyFileSync(target, bak); console.log(`${file}: backed up.`); }
  fs.writeFileSync(target, src);
  console.log(`${file}: patched.`);
}

console.log("\nNext: node --check on each, then re-run genbis.js and re-upload bis.json.");
console.log("app.js still needs its three CLASS_SPEC_MAP / ALL_SPECS entries.");
