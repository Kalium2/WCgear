/**
 * patch-handtype.js - genbis.js was comparing a numeric enum as a string.
 *
 * Throwaway. Run once, check the output, delete it.
 *
 * THE BUG:
 *   const handType = dbItem?.handType || "";
 *   const looksTwoHanded = /TwoHand/i.test(handType);
 *
 * db.bin stores handType as an INTEGER enum (proto/common.proto HandType:
 * Unknown 0, MainHand 1, OneHand 2, OffHand 3, TwoHand 4) - verified directly
 * 2026-08-25, Zhar'doom returns handType: 4. So the regex tests the string "4",
 * never matches, and `!handType` is false for any non-zero value. The result:
 * NO generated block has ever been classified as two-handed.
 *
 * Symptom (Survival Hunter, phase3): Twinblade of the Phoenix - a two-handed
 * sword - appears under "Main Hand", while the Two-Hand card reads "the BiS
 * list doesn't include a two-hand recommendation yet" next to the two-hander
 * the player is actually wearing.
 *
 * Affects every generated spec with a two-handed weapon: Affliction,
 * Demonology, Elemental, Enhancement, Balance, Feral, Shadow Priest, Survival,
 * and the eight @2h_* hunter variants. The @dw_* variants were already correct
 * because they have an off-hand.
 *
 * SIM IMPACT IS SMALL: "Two-Hand" and "Main Hand" both map to equipment index
 * 14, so the right item still reached the right slot, and upgrades.js reads
 * handType from db.bin numerically for its off-hand clearing. This is a
 * classification and display bug - but the Compare panel is what a player reads.
 *
 * Requires re-running genbis.js and re-uploading bis.json.
 */

const fs = require("fs");
const path = require("path");

const FILE = "/root/wow-gear-check-server/genbis.js";

const ANCHOR = `    const dbItem = getItem(mh.id);
    const handType = dbItem?.handType || "";
    const looksTwoHanded = /TwoHand/i.test(handType);
    const twoHanded = (!oh || !oh.id) && (looksTwoHanded || !handType);`;

const REPLACEMENT = `    // proto/common.proto HandType: Unknown 0, MainHand 1, OneHand 2,
    // OffHand 3, TwoHand 4. db.bin stores this as an INTEGER, not a string -
    // the previous /TwoHand/i.test(handType) tested "4" and never matched, so
    // no generated block was ever classified two-handed.
    const HAND_TYPE_TWO_HAND = 4;
    const dbItem = getItem(mh.id);
    const handType = dbItem && typeof dbItem.handType === "number" ? dbItem.handType : null;
    // Unknown item, or an item with no hand type recorded: fall back to the
    // shape of the set itself - a main hand with no off-hand is a two-hander.
    const looksTwoHanded = handType === null ? true : handType === HAND_TYPE_TWO_HAND;
    const twoHanded = (!oh || !oh.id) && looksTwoHanded;`;

let src = fs.readFileSync(FILE, "utf8");

if (src.includes("HAND_TYPE_TWO_HAND")) {
  console.log("genbis.js: already patched. Nothing to do.");
  process.exit(0);
}

if (!src.includes(ANCHOR)) {
  console.error("ABORT: buildSpecBlock's hand-type block does not match.\nExpected:\n\n" + ANCHOR + "\n");
  console.error("Paste me the current buildSpecBlock and I will re-anchor it.");
  process.exit(1);
}

src = src.replace(ANCHOR, REPLACEMENT);

const bak = FILE + ".bak-handtype";
if (fs.existsSync(bak)) console.log("Backup already exists, leaving it alone.");
else { fs.copyFileSync(FILE, bak); console.log("Backed up to " + path.basename(bak)); }

fs.writeFileSync(FILE, src);
console.log("Patched genbis.js.");
console.log("");
console.log("Now: node genbis.js, then check a few weaponConfig values before uploading.");
