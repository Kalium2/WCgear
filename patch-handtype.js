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
 * Affects every generated spec with a two-handed weapon. The @dw_* hunter
 * variants and Enhancement were already correct - they have a real off-hand,
 * so the off-hand test alone got them right.
 *
 * SIM IMPACT IS SMALL: "Two-Hand" and "Main Hand" both map to equipment index
 * 14, so the right item still reached the right slot, and upgrades.js reads
 * handType from db.bin numerically for its off-hand clearing. This is a
 * classification and display bug - but the Compare panel is what a player reads.
 *
 * ANCHORED BY REGEX, not exact text: the first version of this patch used a
 * literal four-line anchor and aborted against the real file, whose blank-line
 * layout differs from the copy served by Pages. Matching statement-to-statement
 * with tolerant whitespace survives that; the abort still fires if the logic
 * itself has changed.
 *
 * Requires re-running genbis.js and re-uploading bis.json.
 */

const fs = require("fs");
const path = require("path");

const FILE = "/root/wow-gear-check-server/genbis.js";

// Matches from `const dbItem = ...` through the `twoHanded` assignment,
// tolerating any whitespace, blank lines or comments between the statements.
const ANCHOR_RE = new RegExp(
  [
    "const dbItem = getItem\\(mh\\.id\\);",
    "\\s*const handType = dbItem\\?\\.handType \\|\\| \"\";",
    "\\s*const looksTwoHanded = /TwoHand/i\\.test\\(handType\\);",
    "\\s*const twoHanded = \\(!oh \\|\\| !oh\\.id\\) && \\(looksTwoHanded \\|\\| !handType\\);",
  ].join("")
);

const REPLACEMENT = `// proto/common.proto HandType: Unknown 0, MainHand 1, OneHand 2,
    // OffHand 3, TwoHand 4. db.bin stores this as an INTEGER, not a string -
    // the previous /TwoHand/i.test(handType) tested "4" and never matched, so
    // no generated block was ever classified two-handed.
    const HAND_TYPE_TWO_HAND = 4;
    const dbItem = getItem(mh.id);
    const handType = dbItem && typeof dbItem.handType === "number" ? dbItem.handType : null;
    // Unknown item, or one with no hand type recorded: fall back to the shape
    // of the set itself - a main hand with no off-hand is a two-hander.
    const looksTwoHanded = handType === null ? true : handType === HAND_TYPE_TWO_HAND;
    const twoHanded = (!oh || !oh.id) && looksTwoHanded;`;

let src = fs.readFileSync(FILE, "utf8");

if (src.includes("HAND_TYPE_TWO_HAND")) {
  console.log("genbis.js: already patched. Nothing to do.");
  process.exit(0);
}

const matches = src.match(new RegExp(ANCHOR_RE.source, "g"));
if (!matches) {
  console.error("ABORT: could not locate the hand-type block in buildSpecBlock.");
  console.error("Looking for these four statements in order:");
  console.error("  const dbItem = getItem(mh.id);");
  console.error("  const handType = dbItem?.handType || \"\";");
  console.error("  const looksTwoHanded = /TwoHand/i.test(handType);");
  console.error("  const twoHanded = (!oh || !oh.id) && (looksTwoHanded || !handType);");
  process.exit(1);
}
if (matches.length !== 1) {
  console.error(`ABORT: found ${matches.length} matches, expected exactly 1.`);
  process.exit(1);
}

src = src.replace(ANCHOR_RE, REPLACEMENT);

const bak = FILE + ".bak-handtype";
if (fs.existsSync(bak)) console.log("Backup already exists, leaving it alone.");
else { fs.copyFileSync(FILE, bak); console.log("Backed up to " + path.basename(bak)); }

fs.writeFileSync(FILE, src);
console.log("Patched genbis.js - hand type now compared as an integer.");
console.log("");
console.log("Now: node --check genbis.js && node genbis.js");
console.log("Expect twohand for the caster specs, Survival and the @2h_* variants;");
console.log("Enhancement and the @dw_* variants should STAY mainhand_offhand.");
