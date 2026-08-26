/**
 * patch-weave.js - stop hunters melee weaving.
 *
 * Throwaway. Run once, check the output, delete it.
 *
 * THE BUG: wowsims APL files carry tuneable `valueVariables` that their UI
 * exposes. We deserialise the file straight into Player.rotation and never
 * touch them, so every variable keeps the FILE's default. The hunter APL
 * defaults "Melee weave" to true.
 *
 * Measured 2026-08-25 on Drexion (BM, phase3): stripping both melee weapons
 * dropped him from 2875.6 to 2070.0 - melee was 28.0% of total damage. A
 * raiding hunter turrets; weaving is a fight-specific exception. Confirmed by
 * Dan as SME.
 *
 * CONSEQUENCES - expect large moves, all downward for hunters:
 *   - hunter DPS falls substantially toward the no-melee-weapon figure
 *   - melee weapon recommendations for hunters collapse to a stat trade
 *     (Halberd of Desolation read +238.7 here vs +44.86 on wowsims)
 *   - the BM Hunter parity baseline (3426.5 vs 3739.91) is void: it compared
 *     a weaving hunter against a turret one
 *   - loot-check comparisons have been systematically favouring hunters
 *
 * THE GENERAL LESSON: an APL is not just a priority list. Anything the wowsims
 * UI lets you tune lives in valueVariables, and every one we do not set is a
 * silent default we never chose. Worth auditing the other classes' APLs.
 */

const fs = require("fs");
const path = require("path");

const FILE = "/root/wow-gear-check-server/classspecs.js";

const LOADER_ANCHOR =
  'const loadApl = (p) => JSON.parse(fs.readFileSync(path.join(PRESET_DIR, p), "utf8"));';

const LOADER_REPLACEMENT = `const loadAplFile = (p) => JSON.parse(fs.readFileSync(path.join(PRESET_DIR, p), "utf8"));

// APL files carry tuneable \`valueVariables\` - the knobs wowsims' UI exposes.
// We deserialise the file straight into Player.rotation, so any variable we do
// not override keeps the FILE's default, chosen by upstream for their UI rather
// than by us. That is how every hunter ended up melee weaving: the hunter APL
// ships "Melee weave" = true.
//
// Reads fresh each call, so mutating the parsed object cannot leak between specs.
// An unknown variable name is logged rather than silently ignored - a typo here
// would otherwise look exactly like a working override.
function loadApl(p, variables) {
  const apl = loadAplFile(p);
  if (!variables) return apl;
  if (!Array.isArray(apl.valueVariables)) {
    console.log(\`apl \${p}: no valueVariables block - overrides ignored\`);
    return apl;
  }
  for (const name of Object.keys(variables)) {
    const entry = apl.valueVariables.find((v) => v && v.name === name);
    if (!entry) {
      console.log(\`apl \${p}: no variable named "\${name}" - override IGNORED\`);
      continue;
    }
    // Values are string constants in this format, e.g. {const:{val:"true"}}.
    entry.value = { const: { val: String(variables[name]) } };
  }
  return apl;
}`;

const APL_LINE = '    aplPath: "hunter_dps/apls/default.apl.json",';
const APL_REPLACEMENT = `    aplPath: "hunter_dps/apls/default.apl.json",
    // Hunters turret. Weaving is worth it on a small number of fights and is
    // not the raid default (confirmed with Dan, 2026-08-25). The APL file's own
    // default is true, which had melee at 28% of a hunter's simulated damage.
    aplVariables: { "Melee weave": "false" },`;

const CALL_ANCHOR = "loadApl(spec.aplPath)";
const CALL_REPLACEMENT = "loadApl(spec.aplPath, spec.aplVariables)";

let src = fs.readFileSync(FILE, "utf8");

if (src.includes("aplVariables")) {
  console.log("classspecs.js: already patched. Nothing to do.");
  process.exit(0);
}

// --- checks before any write -----------------------------------------------
const problems = [];
if (!src.includes(LOADER_ANCHOR)) problems.push("loadApl definition not found:\n  " + LOADER_ANCHOR);
if (!src.includes(CALL_ANCHOR)) problems.push("call site not found: " + CALL_ANCHOR);

const aplCount = src.split(APL_LINE).length - 1;
if (aplCount !== 2) {
  problems.push(
    `expected 2 hunter aplPath lines (Beast Mastery + Survival), found ${aplCount}.\n` +
    "  Looking for: " + APL_LINE
  );
}

if (problems.length) {
  console.error("\nABORT: " + problems.length + " problem(s) with classspecs.js\n");
  problems.forEach((p) => console.error("- " + p + "\n"));
  process.exit(1);
}

src = src.replace(LOADER_ANCHOR, LOADER_REPLACEMENT);
src = src.split(APL_LINE).join(APL_REPLACEMENT);       // both hunter specs
src = src.split(CALL_ANCHOR).join(CALL_REPLACEMENT);   // however many call sites

const bak = FILE + ".bak-weave";
if (fs.existsSync(bak)) console.log("Backup already exists, leaving it alone.");
else { fs.copyFileSync(FILE, bak); console.log("Backed up to " + path.basename(bak)); }

fs.writeFileSync(FILE, src);
console.log("Patched classspecs.js - loader now applies aplVariables, both hunter specs turret.");
console.log("");
console.log("EXPECT HUNTER DPS TO FALL HARD. Melee was 28% of Drexion's output.");
console.log("Re-run baselines.js afterwards; the BM Hunter parity figure is void.");
