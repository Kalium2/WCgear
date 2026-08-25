/**
 * patch-specs.js - adds Fury Warrior and Survival Hunter, and spec-keys the
 * gemming-reference preset map.
 *
 * Throwaway. Run once, check the output, delete it.
 *
 * All values transcribed from wowsims/tbc-new ui/<class>/dps/presets.ts,
 * read 2026-08-25. Verified rather than inferred:
 *   - ui/warrior/dps/apls/fury.apl.json EXISTS (same shape as arms.apl.json)
 *   - ui/hunter/dps/apls/survival.apl.json 404s - Hunter has ONE shared APL,
 *     so Survival correctly points at default.apl.json alongside BM.
 *
 * WHY THE PRESET MAP HAD TO CHANGE: PRESET_BY_CLASS_PHASE is keyed by CLASS.
 * That was fine while each class had exactly one sim, and the code comment
 * said as much. Fury is the second Warrior spec, so without spec-keying a
 * Fury warrior would silently borrow the Arms gemming reference - and Arms is
 * a two-hander build while Fury dual-wields.
 *
 * ALSO CORRECTED: Arms carried profession2 "Blacksmithing", which is wowsims'
 * P1/P2 value. From P3 onward upstream switches to Jewelcrafting, and we
 * simulate P3/P4. Worth ~0.1%, but it is the same transcription drift that
 * produced the Felhunter-instead-of-Succubus error.
 */

const fs = require("fs");
const path = require("path");

const DIR = "/root/wow-gear-check-server/";

// Warrior consumables/buffs/party buffs are shared across builds upstream, so
// these mirror the existing arms_warrior entry exactly.
const WARRIOR_SHARED = `    consumables: {
      potId: 22838, flaskId: 22854, foodId: 27658, conjuredId: 22788,
      explosiveId: 30217, ohImbueId: 29453,
      superSapper: true, goblinSapper: true, scrollAgi: true, scrollStr: true,
    },
    buffs: { blessingOfKings: true, blessingOfMight: "TristateEffectImproved", unleashedRage: true },
    partyBuffs: {
      battleShout: "TristateEffectImproved",
      strengthOfEarthTotem: "TristateEffectImproved",
      graceOfAirTotem: "TristateEffectImproved",
      windfuryTotem: "TristateEffectImproved",
      leaderOfThePack: "TristateEffectImproved",
      braidedEterniumChain: true,
      totemTwisting: true,
      drums: "LesserDrumsOfBattle",
      ferociousInspiration: 2,
    },`;

const HUNTER_SHARED = `    consumables: {
      battleElixirId: 22831, guardianElixirId: 22840, foodId: 27659,
      potId: 22838, conjuredId: 12662, explosiveId: 30217, petFoodId: 33874,
      petScrollAgi: true, petScrollStr: true,
      superSapper: true, goblinSapper: true, scrollAgi: true, scrollStr: true,
    },
    buffs: {
      blessingOfKings: true,
      blessingOfMight: "TristateEffectImproved",
      blessingOfWisdom: "TristateEffectImproved",
      unleashedRage: true,
    },
    partyBuffs: {
      battleShout: "TristateEffectImproved",
      strengthOfEarthTotem: "TristateEffectImproved",
      graceOfAirTotem: "TristateEffectImproved",
      windfuryTotem: "TristateEffectImproved",
      leaderOfThePack: "TristateEffectImproved",
      braidedEterniumChain: true,
      totemTwisting: true,
      drums: "LesserDrumsOfBattle",
      ferociousInspiration: 1,
    },`;

const NEW_SPECS = `const CLASS_SPECS = {
  // --- Added 2026-08-25 from wowsims presets.ts ---------------------------
  fury_warrior: {
    key: "fury_warrior",
    label: "Fury",
    specField: "dpsWarrior",
    class: "ClassWarrior",
    race: "RaceOrc",
    talents: "3400502130201-05050005505012050115",
    aplPath: "warrior_dps/apls/fury.apl.json",
    profession1: "Engineering",
    profession2: "Jewelcrafting", // P3+ value upstream; P1/P2 used Blacksmithing
    distanceFromTarget: 25,
    classOptions: {
      queueDelay: 250,
      startingRage: 50,
      defaultShout: "WarriorShoutBattle",
      defaultStance: "WarriorStanceBerserker",
      hasBsT2: true,
      stanceSnapshot: true,
    },
${WARRIOR_SHARED}
  },
  survival_hunter: {
    key: "survival_hunter",
    label: "Survival",
    specField: "hunter",
    class: "ClassHunter",
    race: "RaceOrc",
    // Hunter has ONE APL upstream - ui/hunter/dps/apls/survival.apl.json 404s,
    // so this is the same file BM uses, not an oversight.
    talents: "502-0550201205-333200022003223005103",
    aplPath: "hunter_dps/apls/default.apl.json",
    profession1: "Engineering",
    profession2: "Blacksmithing",
    distanceFromTarget: 7,
    classOptions: {
      ammo: "WardensArrow",
      quiverBonus: "Speed15",
      petType: "Ravager",
      petUptime: 1,
      petSingleAbility: false,
    },
${HUNTER_SHARED}
  },`;

const PRESET_HELPER = `// Gemming reference sets, keyed by SPEC. Was keyed by CLASS, which worked only
// while every class had exactly one sim - Fury is the second Warrior spec, and
// Arms is a two-hander build while Fury dual-wields, so they must not share.
//
// Survival deliberately points at the BM sets: these files supply GEMMING ONLY
// (the recommended items themselves come from bis.json), both are Hunters with
// near-identical stat priorities, and upstream's Survival sets are nested under
// a phase_N/sv/{2h,dw}_{Np} scheme that would need its own mapping table for
// no measurable gain. Revisit if Survival ever looks off.
const PRESET_BY_SPEC_PHASE = {
  arms_warrior:         { phase3: "presets/warrior_dps/p3_arms.gear.json", phase4: "presets/warrior_dps/p4_arms.gear.json" },
  fury_warrior:         { phase3: "presets/warrior_dps/p3_fury.gear.json", phase4: "presets/warrior_dps/p4_fury.gear.json" },
  beast_mastery_hunter: { phase3: "presets/hunter_dps/p3_bm.gear.json",    phase4: "presets/hunter_dps/p4_bm.gear.json" },
  survival_hunter:      { phase3: "presets/hunter_dps/p3_bm.gear.json",    phase4: "presets/hunter_dps/p4_bm.gear.json" },
};

// Spec first, class second. The class fallback keeps Warlock and Shaman working
// unchanged, and means a newly added spec degrades to its class's gemming
// rather than failing outright.
function presetPathFor(specKey, className, phaseKey) {
  const bySpec = specKey && PRESET_BY_SPEC_PHASE[specKey] && PRESET_BY_SPEC_PHASE[specKey][phaseKey];
  if (bySpec) return bySpec;
  return (PRESET_BY_CLASS_PHASE[className] && PRESET_BY_CLASS_PHASE[className][phaseKey]) || null;
}

const PRESET_BY_CLASS_PHASE = {`;

const WORK = [
  ["classspecs.js", "fury_warrior", [
    ["const CLASS_SPECS = {", NEW_SPECS],
    ['profession2: "Blacksmithing",\n    distanceFromTarget: 25,',
     'profession2: "Jewelcrafting", // P3+ value upstream; P1/P2 used Blacksmithing\n    distanceFromTarget: 25,'],
  ]],
  ["server.js", "presetPathFor", [
    ["const PRESET_BY_CLASS_PHASE = {", PRESET_HELPER],
    ["    const presetFile = PRESET_BY_CLASS_PHASE[player.type] && PRESET_BY_CLASS_PHASE[player.type][phaseKey];",
     "    const presetFile = presetPathFor(spec, player.type, phaseKey);"],
    ["  PRESET_BY_CLASS_PHASE,\n  allItemsMap,",
     "  PRESET_BY_CLASS_PHASE,\n  presetPathFor,\n  allItemsMap,"],
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
    console.error(`\nABORT: ${missing.length} anchor(s) did not match ${file}.\n`);
    missing.forEach(([a]) => console.error("--- expected ---\n" + a + "\n"));
    process.exit(1);
  }
  for (const [a, r] of edits) src = src.replace(a, r);
  staged.push([file, src]);
}

if (!staged.length) { console.log("\nNothing to do."); process.exit(0); }

for (const [file, src] of staged) {
  const target = path.join(DIR, file);
  const bak = target + ".bak-specs";
  if (fs.existsSync(bak)) console.log(`${file}: backup already exists, leaving it alone.`);
  else { fs.copyFileSync(target, bak); console.log(`${file}: backed up to ${path.basename(bak)}`); }
  fs.writeFileSync(target, src);
  console.log(`${file}: patched.`);
}

console.log("\nDone. Required files before restarting:");
console.log("  presets/warrior_dps/apls/fury.apl.json");
console.log("  presets/warrior_dps/p3_fury.gear.json");
console.log("  presets/warrior_dps/p4_fury.gear.json");
