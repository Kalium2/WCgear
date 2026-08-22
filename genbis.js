/**
 * bis.json generator — turns wowsims preset gear sets into bis.json blocks.
 * ============================================================
 * WHY: bis.json is hand-curated from Wowhead guides, which is fine for a
 * handful of specs and untenable for twenty. wowsims publishes a gear set
 * for every spec it simulates, so this converts those into the bis.json
 * schema rather than typing them out.
 *
 * Wowhead remains the display layer regardless — the site renders names,
 * icons, quality colours and tooltips from item IDs via Wowhead's script,
 * so where the IDs came from doesn't change what a player sees.
 *
 * INTEGRITY RULES:
 *   1. Never overwrite a hand-curated block. A spec block is considered
 *      curated unless it carries `_source: "wowsims-preset"`.
 *   2. Every generated block records its provenance and the preset file
 *      it came from, so it's auditable in git.
 *   3. Generated entries carry their gems and enchant, making them
 *      self-contained — the sweep then stops inferring gems from a
 *      preset, which silently understated items whose socket count
 *      differed from the preset item's.
 *
 * CAVEAT: wowsims keeps one gear set per tier for a whole class-role
 * (ui/warlock/dps/gear_sets/t6.gear.json covers all three DPS specs), so
 * generated blocks for sibling specs name the same items. Also, presets
 * are a single set — generated entries are all rank 1, with no ranked
 * alternatives. Curated blocks keep theirs.
 *
 * USAGE:  node genbis.js
 * Writes generated-bis.json, then serve/download it and commit to GitHub.
 * ============================================================
 */

const fs = require("fs");
const path = require("path");
const { loadGameDatabase, getItem } = require("./gamedb");

const LIVE_BIS_URL = "https://kalium2.github.io/WCgear/bis.json";
const OUT_FILE = path.join(__dirname, "generated-bis.json");

/** What to generate. Extend as more specs get a working sim. */
const GENERATE = [
  { spec: "affliction_warlock", phase: "phase3", preset: "presets/warlock/t6.gear.json" },
  { spec: "affliction_warlock", phase: "phase4", preset: "presets/warlock/za.gear.json" },
  { spec: "demonology_warlock", phase: "phase3", preset: "presets/warlock/t6.gear.json" },
  { spec: "demonology_warlock", phase: "phase4", preset: "presets/warlock/za.gear.json" },
];

/** wowsims ItemSlot index -> bis.json slot key. 14/15 handled separately
 *  because bis.json splits weapons into twohand vs mainhand+offhand. */
const SLOT_KEYS = [
  "head", "neck", "shoulder", "back", "chest", "wrist", "hands", "waist",
  "legs", "feet", "finger", "finger", "trinket", "trinket",
  null, null, "ranged",
];

function entryFor(itemSpec, rank) {
  const dbItem = getItem(itemSpec.id);
  const entry = {
    itemId: itemSpec.id,
    rank,
    name: dbItem?.name || `Item ${itemSpec.id}`,
    // Drop location isn't in the wowsims database, so generated entries
    // leave it blank rather than inventing one. Fill in by hand if it
    // matters for a given spec.
    source: "",
  };
  if (itemSpec.enchant) entry.enchant = itemSpec.enchant;
  if (itemSpec.gems?.length) entry.gems = itemSpec.gems.filter(Boolean);
  return entry;
}

/** Converts a .gear.json items array into one bis.json spec block. */
function buildSpecBlock(presetItems, presetFile) {
  const block = { _source: "wowsims-preset", _preset: presetFile };

  presetItems.forEach((itemSpec, slot) => {
    if (!itemSpec || !itemSpec.id) return;
    const key = SLOT_KEYS[slot];
    if (!key) return; // weapons handled below
    if (!block[key]) block[key] = [];
    block[key].push(entryFor(itemSpec, block[key].length + 1));
  });

  // Weapons. wowsims puts any weapon at index 14 and only fills 15 when
  // there's a genuine off-hand, so off-hand presence is what distinguishes
  // the two builds. Cross-checked against the item's own hand type where
  // the database exposes one.
  const mh = presetItems[14];
  const oh = presetItems[15];

  if (mh && mh.id) {
    const dbItem = getItem(mh.id);
    const handType = dbItem?.handType || "";
    const looksTwoHanded = /TwoHand/i.test(handType);
    const twoHanded = (!oh || !oh.id) && (looksTwoHanded || !handType);

    if (twoHanded) {
      block.weaponConfig = "twohand";
      block.twohand = [entryFor(mh, 1)];
    } else {
      block.weaponConfig = "mainhand_offhand";
      block.mainhand = [entryFor(mh, 1)];
      if (oh && oh.id) block.offhand = [entryFor(oh, 1)];
    }
  }

  return block;
}

(async () => {
  await loadGameDatabase();

  console.log(`Fetching current bis.json from ${LIVE_BIS_URL} ...`);
  const res = await fetch(LIVE_BIS_URL);
  if (!res.ok) throw new Error(`Could not fetch bis.json (HTTP ${res.status}).`);
  const bis = await res.json();

  let written = 0;
  let skipped = 0;

  for (const job of GENERATE) {
    const existing = bis[job.phase]?.[job.spec];

    // Rule 1: never clobber hand-curated data.
    if (existing && existing._source !== "wowsims-preset") {
      console.log(`  SKIP  ${job.phase}/${job.spec} — already curated by hand.`);
      skipped++;
      continue;
    }

    const presetPath = path.join(__dirname, job.preset);
    if (!fs.existsSync(presetPath)) {
      console.log(`  SKIP  ${job.phase}/${job.spec} — preset missing: ${job.preset}`);
      skipped++;
      continue;
    }

    const preset = JSON.parse(fs.readFileSync(presetPath, "utf8"));
    const block = buildSpecBlock(preset.items || [], job.preset);

    if (!bis[job.phase]) bis[job.phase] = {};
    bis[job.phase][job.spec] = block;

    const slots = Object.keys(block).filter((k) => !k.startsWith("_") && k !== "weaponConfig").length;
    console.log(`  WRITE ${job.phase}/${job.spec} — ${slots} slots from ${job.preset}`);
    written++;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(bis, null, 2) + "\n");
  console.log(`\n${written} block(s) generated, ${skipped} skipped.`);
  console.log(`Wrote ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB).`);
  console.log("Review it, then commit it to the GitHub repo as bis.json.");
})().catch((err) => {
  console.error("Generation failed:", err.message);
  process.exit(1);
});
