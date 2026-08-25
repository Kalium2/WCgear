/**
 * patch-offhand.js - two-handers must unequip the off-hand.
 *
 * Throwaway. Run once, check the output, delete it.
 *
 * THE BUG: EquipmentSpec.items is positional, and both "Two-Hand" and
 * "Main Hand" map to index 14. Swapping in a two-handed weapon replaced index
 * 14 and left index 15 populated, so the sim ran a player holding a two-hander
 * AND an off-hand - an impossible set-up that banks stats from a slot that
 * would really be empty.
 *
 * Confirmed live 2026-08-25: Kalium (Affliction, phase3) vs Zhar'doom read
 * +169.9 through the sweep and +120.2 through the loot check, which already
 * clears the off-hand. Same character, same spec, same phase. ~50 DPS of pure
 * inflation, and it applies to every two-hander for anyone dual-wielding.
 *
 * Present in TWO places - the per-slot swap and the full-recommended-set run,
 * so the headline "Full recommended set" figure was overstated as well.
 *
 * Same family as the unique-trinket double-equip fixed on the 22nd: wowsimtbc
 * does not reject the impossible set-up, it just answers a question nobody
 * asked.
 */

const fs = require("fs");
const path = require("path");

const FILE = "/root/wow-gear-check-server/upgrades.js";
let src = fs.readFileSync(FILE, "utf8");

if (src.includes("clearsOffHand")) {
  console.log("upgrades.js: already patched. Nothing to do.");
  process.exit(0);
}

const edits = [];

// --- 1. Need the item database to know what is a two-hander ----------------
edits.push([
  'const { runSimulation, buildEquipmentSpec } = require("./sim");',
  'const { runSimulation, buildEquipmentSpec } = require("./sim");\n' +
  'const { getItem } = require("./gamedb");\n' +
  '\n' +
  '// proto/common.proto: ItemType.ItemTypeWeapon = 13, HandType.HandTypeTwoHand = 4.\n' +
  '// Declared locally rather than imported from lootcheck.js, which requires\n' +
  '// SLOT_NAMES from this file - importing back would be circular.\n' +
  'const ITEM_TYPE_WEAPON = 13;\n' +
  'const HAND_TYPE_TWO_HAND = 4;\n' +
  'const OFF_HAND_SLOT = 15;\n' +
  '\n' +
  'function isTwoHander(itemId) {\n' +
  '  if (!itemId) return false;\n' +
  '  const it = getItem(itemId);\n' +
  '  return Boolean(it && it.type === ITEM_TYPE_WEAPON && it.handType === HAND_TYPE_TWO_HAND);\n' +
  '}',
]);

// --- 2. Record the displaced off-hand on the result ------------------------
edits.push([
  `    const base = {
      slot: c.slot,
      slotName: SLOT_NAMES[c.slot],
      recommendedItemId: c.preset.id,
      equippedItemId: c.equippedId,
    };`,
  `    // A two-hander into the main hand also empties the off-hand. Surfaced on
    // the result so the UI can show that the gain costs them that slot.
    const clearsOffHand =
      c.slot === 14 &&
      isTwoHander(c.preset.id) &&
      Boolean((current.items[OFF_HAND_SLOT] || {}).id);

    const base = {
      slot: c.slot,
      slotName: SLOT_NAMES[c.slot],
      recommendedItemId: c.preset.id,
      equippedItemId: c.equippedId,
      replacedOffHandItemId: clearsOffHand ? current.items[OFF_HAND_SLOT].id : null,
    };`,
]);

// --- 3. The per-slot swap --------------------------------------------------
edits.push([
  `    const swapped = {
      items: current.items.map((it, i) =>
        i === c.slot
          ? {
              id: c.preset.id,
              randomSuffix: c.preset.randomSuffix || 0,
              enchant: c.preset.enchant || 0,
              gems: c.preset.gems || [],
            }
          : it
      ),
    };`,
  `    const swapped = {
      items: current.items.map((it, i) => {
        if (i === c.slot) {
          return {
            id: c.preset.id,
            randomSuffix: c.preset.randomSuffix || 0,
            enchant: c.preset.enchant || 0,
            gems: c.preset.gems || [],
          };
        }
        // {} is what buildEquipmentSpec emits for an empty slot, so later
        // indices do not shift.
        if (clearsOffHand && i === OFF_HAND_SLOT) return {};
        return it;
      }),
    };`,
]);

// --- 4. The full-recommended-set run --------------------------------------
edits.push([
  `  const fullItems = current.items.map((it, i) => {
    const t = presetItems && presetItems[i];
    if (!t || !t.id) return it;
    return { id: t.id, randomSuffix: t.randomSuffix || 0, enchant: t.enchant || 0, gems: t.gems || [] };
  });`,
  `  const fullItems = current.items.map((it, i) => {
    const t = presetItems && presetItems[i];
    if (!t || !t.id) return it;
    return { id: t.id, randomSuffix: t.randomSuffix || 0, enchant: t.enchant || 0, gems: t.gems || [] };
  });

  // Same rule for the whole-set run, which had the bug independently: if the
  // recommended main hand is a two-hander, nothing can occupy the off-hand.
  // Checked against the RESULTING main hand, so it holds whether the
  // two-hander came from the recommendation or was already equipped.
  if (isTwoHander((fullItems[14] || {}).id)) fullItems[OFF_HAND_SLOT] = {};`,
]);

// --- Apply, aborting loudly on any missing anchor --------------------------
const missing = edits.filter(([anchor]) => !src.includes(anchor));
if (missing.length) {
  console.error("ABORT: " + missing.length + " anchor(s) did not match upgrades.js.\n");
  missing.forEach(([a]) => console.error("--- expected ---\n" + a + "\n"));
  process.exit(1);
}

for (const [anchor, replacement] of edits) src = src.replace(anchor, replacement);

const bak = FILE + ".bak-offhand";
if (fs.existsSync(bak)) console.log("Backup already exists, leaving it alone.");
else { fs.copyFileSync(FILE, bak); console.log("Backed up to " + path.basename(bak)); }

fs.writeFileSync(FILE, src);
console.log("Patched upgrades.js - all 4 edits applied.");
console.log("Now: node --check upgrades.js && pm2 restart wow-gear-check");
